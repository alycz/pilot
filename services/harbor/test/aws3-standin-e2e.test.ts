import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";
import type { DelegateSet } from "xrpl";

import type { XrplRpc } from "../src/adapters/xrpl-rpc";
import { awsFetch, type AwsFetchEnv } from "../src/aws/sigv4";
import type { OpContext } from "../src/catalog/registry";
import { DEFAULT_POLICY, type Network } from "../src/contracts";
import type { DelegationLedgerAdapter } from "../src/exec/delegation";
import { signDelegatedTransaction } from "../src/exec/sign";
import { decodeSignedBlob, signedTransactionHash } from "../src/exec/submit";
import { Store } from "../src/exec/store";
import {
  handleAccountLink,
  handleAccountRevoke,
  handleAccountStatus,
  type AccountServices,
} from "../src/ops/account";
import { handleTxExecute } from "../src/ops/tx-exec";
import { MemoryKeyStore } from "../tools/aws-local/src/key-store";
import { dispatchAwsLocalRequest } from "../tools/aws-local/src/server";

const PRINCIPAL = "aws3-standin-composite";
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const NOW = "2026-10-21T12:00:00.000Z";
const LOCAL_ENDPOINT = "http://127.0.0.1:8790/";

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
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value as SqlValue;
}

class SqliteD1Statement {
  private values: SqlValue[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): this {
    this.values = values.map(sqliteValue);
    return this;
  }

  private execute(): D1Result {
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
      const results = await Promise.all(statements.map((statement) => statement.run()));
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

function record(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string): string {
  const result = record(value)[field];
  expect(result).toBeTypeOf("string");
  return result as string;
}

describe("AWS-3 stand-in composite check", () => {
  it("wraps, signs, records provenance, and suspends through KMS KEK mode without a legacy KEK", async () => {
    const kmsStore = new MemoryKeyStore();
    const awsRequests: Array<{ target?: string; authorization: string }> = [];
    const localFetch = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname !== "127.0.0.1") {
        throw new Error("AWS-3 composite fixture permits only the in-process loopback stand-in");
      }
      const authorization = request.headers.get("authorization") ?? "";
      const target = request.headers.get("x-amz-target") ?? undefined;
      awsRequests.push({ ...(target ? { target } : {}), authorization });
      const response = await dispatchAwsLocalRequest(
        {
          method: request.method,
          ...(authorization ? { authorization } : {}),
          path: url.pathname,
          contentType: request.headers.get("content-type") ?? undefined,
          ...(target ? { target } : {}),
          body: await request.clone().json(),
        },
        { store: kmsStore },
      );
      return Response.json(response.body, { status: response.statusCode });
    });
    vi.stubGlobal("fetch", localFetch);

    const db = new SqliteD1();
    try {
      const setupEnv: AwsFetchEnv = {
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "AWS_LOCAL_SETUP_ONLY_NOT_A_CREDENTIAL",
        AWS_SECRET_ACCESS_KEY: "aws-local-setup-only-not-a-credential",
        AWS_ENDPOINT_OVERRIDE: LOCAL_ENDPOINT,
        EXEC_NETWORK: "testnet",
        HARBOR_LOCAL_DEV: "true",
      };
      const created = await awsFetch(
        "kms",
        "TrentService.CreateKey",
        { KeySpec: "SYMMETRIC_DEFAULT", KeyUsage: "ENCRYPT_DECRYPT" },
        { env: setupEnv },
      );
      const keyId = stringField(record(created).KeyMetadata, "KeyId");
      await awsFetch(
        "kms",
        "TrentService.CreateAlias",
        { AliasName: "alias/harbor/kek", TargetKeyId: keyId },
        { env: setupEnv },
      );
      const syntheticKek = new Uint8Array(32).fill(0xa3);
      let encrypted: unknown;
      try {
        encrypted = await awsFetch(
          "kms",
          "TrentService.Encrypt",
          {
            KeyId: "alias/harbor/kek",
            Plaintext: Buffer.from(syntheticKek).toString("base64"),
            EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
          },
          { env: setupEnv },
        );
      } finally {
        syntheticKek.fill(0);
      }
      expect([...syntheticKek]).toEqual(new Array(32).fill(0));

      const kmsEnv = {
        KMS_MODE: "kek",
        HARBOR_KEK_CIPHERTEXT: stringField(encrypted, "CiphertextBlob"),
        AWS_REGION: "us-east-1",
        AWS_ENDPOINT_OVERRIDE: LOCAL_ENDPOINT,
        EXEC_NETWORK: "testnet" as const,
        HARBOR_LOCAL_DEV: "true",
      };
      expect(kmsEnv).not.toHaveProperty("HARBOR_KEK");
      expect(kmsEnv).not.toHaveProperty("AWS_ACCESS_KEY_ID");
      expect(kmsEnv).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
      expect(kmsEnv).not.toHaveProperty("AWS_SESSION_TOKEN");

      let delegateEntry:
        | {
            LedgerEntryType: "Delegate";
            Account: string;
            Authorize: string;
            Permissions: Array<{ Permission: { PermissionValue: string } }>;
            ledger_index: number;
          }
        | undefined;
      const ledger: DelegationLedgerAdapter = {
        prepareTransaction: async (_network: Network, transaction: DelegateSet) => ({
          ...transaction,
          Fee: "12",
          Sequence: 7,
          LastLedgerSequence: 200,
        }),
        readDelegate: async () => delegateEntry ?? null,
        isAccountFunded: async () => true,
      };
      const store = new Store(asD1(db), PRINCIPAL);
      const accountServices: AccountServices = {
        store,
        ledger,
        now: () => new Date(NOW),
        randomUUID: () => "aws3-standin-link",
      };
      const accountContext: OpContext = {
        principal: PRINCIPAL,
        db: asD1(db),
        env: kmsEnv,
        accountServices,
      };

      const linked = await handleAccountLink(accountContext, {
        owner: OWNER,
        network: "testnet",
        permissions: ["OfferCancel"],
      });
      expect(linked).toMatchObject({
        owner: OWNER,
        network: "testnet",
        status: "pending",
        permissions: ["OfferCancel"],
        delegate_set_tx: {
          TransactionType: "DelegateSet",
          Account: OWNER,
          Authorize: linked.delegate,
        },
      });
      const pendingRow = await store.getLink(OWNER, "testnet");
      expect(pendingRow?.delegateSeedEnc.byteLength).toBeGreaterThan(32);
      expect(pendingRow?.iv.byteLength).toBe(12);

      delegateEntry = {
        LedgerEntryType: "Delegate",
        Account: OWNER,
        Authorize: linked.delegate,
        Permissions: [{ Permission: { PermissionValue: "OfferCancel" } }],
        ledger_index: 100,
      };
      const active = await handleAccountStatus(accountContext, {
        owner: OWNER,
        network: "testnet",
      });
      expect(active).toMatchObject({ status: "active", delegate: linked.delegate });

      await store.insertPolicy({
        owner: OWNER,
        network: "testnet",
        json: { ...DEFAULT_POLICY },
        updatedAt: NOW,
      });
      const build = await store.insertBuild({
        id: "aws3-standin-build",
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
      });
      const xrplRpc: XrplRpc = {
        request: async (_network, command) => {
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
            return { drops: { open_ledger_fee: "10" }, ledger_current_index: 100 };
          }
          if (command === "simulate") {
            return {
              engine_result: "tesSUCCESS",
              engine_result_message: "Synthetic offline simulation succeeded.",
              applied: false,
            };
          }
          throw new Error(`Unexpected synthetic XRPL command: ${command}`);
        },
      };
      let submittedHash: string | undefined;
      const executionContext: OpContext = {
        ...accountContext,
        xrplRpc,
        executionServices: {
          facts: {
            getPolicyFacts: async () => ({ usdValue: "10", issuerFacts: [] }),
          },
          submitSigned: async ({ txBlob }: { txBlob: string }) => {
            const decoded = decodeSignedBlob(txBlob);
            expect(decoded).toMatchObject({
              TransactionType: "OfferCancel",
              Account: OWNER,
              Delegate: linked.delegate,
              OfferSequence: 1,
            });
            expect(decoded.SigningPubKey).toMatch(/^ED[A-F0-9]{64}$/);
            expect(decoded.TxnSignature).toMatch(/^[A-F0-9]+$/);
            submittedHash = signedTransactionHash(txBlob).toUpperCase();
            return {
              hash: submittedHash,
              ledger_index: 198,
              engine_result: "tesSUCCESS",
              validated: true as const,
            };
          },
          now: () => new Date(NOW),
          randomUUID: () => "aws3-standin-execution",
        },
      };
      const executed = await handleTxExecute(executionContext, {
        build_id: build.id,
        idempotency_key: "aws3-standin-idempotency",
      });
      expect(executed).toEqual({
        status: "executed",
        hash: submittedHash,
        ledger_index: 198,
        result: "success",
        signed_by: "delegate",
        signer: { kind: "aws-kms-kek", key_ref: "alias/harbor/kek" },
        confirmation: { provider: "poll", at: NOW, latency_ms: 0 },
      });
      await expect(
        store.getEvent("execution-signer:aws3-standin-execution"),
      ).resolves.toMatchObject({
        kind: "execution_signer",
        detail: {
          signer: { kind: "aws-kms-kek", key_ref: "alias/harbor/kek" },
        },
      });

      const revoked = await handleAccountRevoke(accountContext, {
        owner: OWNER,
        network: "testnet",
      });
      expect(revoked).toMatchObject({
        status: "suspended",
        revoke_tx: {
          TransactionType: "DelegateSet",
          Account: OWNER,
          Authorize: linked.delegate,
          Permissions: [],
        },
      });
      await expect(
        signDelegatedTransaction(executionContext, {
          network: "testnet",
          owner: OWNER,
          txJson: build.txJson,
        }),
      ).rejects.toMatchObject({ code: "LINK_NOT_ACTIVE" });

      expect(
        awsRequests.map(({ target }) => target),
      ).toEqual([
        "TrentService.CreateKey",
        "TrentService.CreateAlias",
        "TrentService.Encrypt",
        "TrentService.Decrypt",
      ]);
      expect(
        awsRequests.every(({ authorization }) =>
          authorization.startsWith("AWS4-HMAC-SHA256 "),
        ),
      ).toBe(true);
      expect(awsRequests.at(-1)?.authorization).toContain(
        "Credential=LOCAL_STANDIN_ONLY_NOT_A_CREDENTIAL/",
      );
    } finally {
      vi.unstubAllGlobals();
      db.close();
    }
  });
});
