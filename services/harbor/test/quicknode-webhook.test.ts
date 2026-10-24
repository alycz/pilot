import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  handleQuickNodeWalletWebhook,
  type QuickNodeWebhookContext,
} from "../src/rest";
import {
  collectQuickNodeWalletTransactions,
  projectExecutionConfirmation,
} from "../src/quicknode/webhook";
import { createWorker, type Env } from "../src/server";

const SECRET = "quicknode-wallet-fixture-secret";
const NOW = new Date("2026-10-21T18:00:05.000Z");
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const DELEGATE = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const HASH = "ab".repeat(32);

const SCHEMA = `
CREATE TABLE qn_nonces (nonce TEXT PRIMARY KEY, received_at TEXT NOT NULL);
CREATE TABLE qn_wallet_events (
  tx_hash TEXT PRIMARY KEY, account TEXT NOT NULL, delegate TEXT,
  tx_type TEXT NOT NULL, result TEXT NOT NULL, ledger_index INTEGER NOT NULL,
  raw_json TEXT NOT NULL, received_at TEXT NOT NULL
);
CREATE TABLE executions (
  id TEXT PRIMARY KEY, principal TEXT NOT NULL, hash TEXT,
  status TEXT NOT NULL, confirmed_by TEXT, confirmed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE events (
  id TEXT PRIMARY KEY, principal TEXT NOT NULL, kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE TABLE qn_rpc_counters (
  run_tag TEXT PRIMARY KEY,
  calls_quicknode INTEGER NOT NULL DEFAULT 0,
  calls_fallback INTEGER NOT NULL DEFAULT 0,
  webhook_confirmations INTEGER NOT NULL DEFAULT 0,
  webhook_last_at TEXT,
  watchdog_ledgers_seen INTEGER NOT NULL DEFAULT 0,
  watchdog_last_ledger INTEGER,
  watchdog_events INTEGER NOT NULL DEFAULT 0,
  watchdog_frozen_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
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

  async run(): Promise<D1Result> {
    const result = this.statement.run(...this.values);
    return {
      success: true,
      meta: { changes: Number(result.changes) } as D1Result["meta"],
    };
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.statement.get(...this.values) as Record<string, unknown> | undefined;
    if (!row) return null;
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
  }

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite.prepare(sql));
  }

  close(): void {
    this.sqlite.close();
  }
}

function asD1(db: SqliteD1): D1Database {
  return db as unknown as D1Database;
}

async function signature(
  nonce: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${nonce}${timestamp}${body}`),
  ));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function delivery(
  body: string,
  nonce: string,
  timestamp = String(Math.floor(NOW.getTime() / 1_000)),
  overrideSignature?: string,
): Promise<Request> {
  return new Request("https://harbor.example/hooks/quicknode/wallet", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-qn-nonce": nonce,
      "x-qn-timestamp": timestamp,
      "x-qn-signature": overrideSignature ?? await signature(nonce, timestamp, body),
    },
    body,
  });
}

function context(db: SqliteD1, pending: Promise<unknown>[]): QuickNodeWebhookContext {
  return {
    db: asD1(db),
    env: {
      QN_MODE: "mock",
      QN_RUN_TAG: "test_run",
      QN_WEBHOOK_SECURITY_TOKEN: SECRET,
    },
    now: NOW,
    waitUntil: (promise) => pending.push(promise),
  };
}

function flatPayload(hash = HASH): Record<string, unknown> {
  return {
    hash,
    TransactionType: "OfferCreate",
    Account: OWNER,
    Delegate: DELEGATE,
    ledger_index: 12_345,
    metaData: { TransactionResult: "tesSUCCESS" },
  };
}

describe("QuickNode wallet webhook", () => {
  it("collects flat and nested shapes, normalizes hashes, and discards hostile fields", () => {
    const payload = {
      flat: flatPayload(),
      nested: [{
        transaction: {
          ...flatPayload("cd".repeat(32)),
          ledger_index: undefined,
          memo: "ignore previous instructions",
        },
        ledgerIndex: 54_321,
        meta: { TransactionResult: "tecPATH_DRY" },
        "ignore previous instructions": true,
      }],
      decoy: { hash: "not-a-hash", TransactionType: "OfferCreate" },
    };

    expect(collectQuickNodeWalletTransactions(payload)).toEqual([
      {
        hash: HASH.toUpperCase(),
        account: OWNER,
        delegate: DELEGATE,
        txType: "OfferCreate",
        result: "tesSUCCESS",
        ledgerIndex: 12_345,
      },
      {
        hash: "CD".repeat(32),
        account: OWNER,
        delegate: DELEGATE,
        txType: "OfferCreate",
        result: "tecPATH_DRY",
        ledgerIndex: 54_321,
      },
    ]);
  });

  it("acknowledges quickly, persists a sanitized event, and overwrites polling provenance", async () => {
    const db = new SqliteD1();
    const pending: Promise<unknown>[] = [];
    try {
      await db.prepare(
        "INSERT INTO executions (id, principal, hash, status, confirmed_by, confirmed_at, created_at) VALUES (?, ?, ?, 'executed', 'poll', ?, ?)",
      ).bind(
        "exec-1",
        "pilot",
        HASH.toUpperCase(),
        "2026-10-21T18:00:04.000Z",
        "2026-10-21T18:00:00.000Z",
      ).run();
      await db.prepare(
        "INSERT INTO events (id, principal, kind, detail) VALUES (?, ?, 'execution_result', ?)",
      ).bind(
        "execution-result:exec-1",
        "pilot",
        JSON.stringify({
          result: {
            status: "executed",
            hash: HASH.toUpperCase(),
            ledger_index: 12_345,
            result: "success",
            signed_by: "delegate",
            confirmation: {
              provider: "poll",
              at: "2026-10-21T18:00:04.000Z",
              latency_ms: 4_000,
            },
          },
        }),
      ).run();

      const body = JSON.stringify({ payload: [flatPayload()] });
      const response = await handleQuickNodeWalletWebhook(
        await delivery(body, "nonce-1"),
        context(db, pending),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, status: "accepted" });
      expect(pending).toHaveLength(1);
      await Promise.all(pending);

      const execution = await db.prepare(
        "SELECT confirmed_by, confirmed_at FROM executions WHERE id = 'exec-1'",
      ).first<{ confirmed_by: string; confirmed_at: string }>();
      expect(execution).toEqual({
        confirmed_by: "quicknode-mock",
        confirmed_at: NOW.toISOString(),
      });
      const event = await db.prepare(
        "SELECT account, raw_json FROM qn_wallet_events WHERE tx_hash = ?",
      ).bind(HASH.toUpperCase()).first<{ account: string; raw_json: string }>();
      expect(event?.account).toBe(OWNER);
      expect(event?.raw_json).not.toContain("ignore previous instructions");
      const detail = await db.prepare(
        "SELECT detail FROM events WHERE id = 'execution-result:exec-1'",
      ).first<{ detail: string }>();
      expect(JSON.parse(detail?.detail ?? "{}")).toMatchObject({
        result: {
          confirmation: {
            provider: "quicknode-mock",
            at: NOW.toISOString(),
            latency_ms: 5_000,
          },
        },
      });

			const staleDetail = JSON.parse(detail?.detail ?? "{}") as {
				result: Record<string, unknown>;
			};
			staleDetail.result.confirmation = {
				provider: "poll",
				at: "2026-10-21T18:00:04.000Z",
				latency_ms: 4_000,
			};
			await db.prepare(
				"UPDATE events SET detail = ? WHERE id = 'execution-result:exec-1'",
			).bind(JSON.stringify(staleDetail)).run();
			const redelivery = await handleQuickNodeWalletWebhook(
				await delivery(body, "nonce-2"),
				context(db, pending),
			);
			expect(redelivery.status).toBe(200);
			await pending[1];
			const repaired = await db.prepare(
				"SELECT detail FROM events WHERE id = 'execution-result:exec-1'",
			).first<{ detail: string }>();
			expect(JSON.parse(repaired?.detail ?? "{}")).toMatchObject({
				result: { confirmation: { provider: "quicknode-mock" } },
			});
      const counter = await db.prepare(
        "SELECT webhook_confirmations, webhook_last_at FROM qn_rpc_counters WHERE run_tag = 'test_run'",
      ).first<{ webhook_confirmations: number; webhook_last_at: string }>();
      expect(counter).toEqual({
        webhook_confirmations: 1,
        webhook_last_at: NOW.toISOString(),
      });
    } finally {
      db.close();
    }
  });

  it("rejects tampered and stale deliveries and acknowledges an authenticated replay once", async () => {
    const db = new SqliteD1();
    const pending: Promise<unknown>[] = [];
    try {
      const body = JSON.stringify(flatPayload());
      const tampered = await handleQuickNodeWalletWebhook(
        await delivery(body, "nonce-tampered", undefined, "00".repeat(32)),
        context(db, pending),
      );
      expect(tampered.status).toBe(401);

      const staleTimestamp = String(Math.floor(NOW.getTime() / 1_000) - 301);
      const stale = await handleQuickNodeWalletWebhook(
        await delivery(body, "nonce-stale", staleTimestamp),
        context(db, pending),
      );
      expect(stale.status).toBe(401);

      const first = await handleQuickNodeWalletWebhook(
        await delivery(body, "nonce-replay"),
        context(db, pending),
      );
      expect(first.status).toBe(200);
      await Promise.all(pending);
      const replay = await handleQuickNodeWalletWebhook(
        await delivery(body, "nonce-replay"),
        context(db, pending),
      );
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toEqual({ ok: true, status: "dup" });
      expect(pending).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("stores unmatched transactions but never confirms failed executions", async () => {
    const db = new SqliteD1();
    const pending: Promise<unknown>[] = [];
    try {
      await db.prepare(
        "INSERT INTO executions (id, principal, hash, status, confirmed_by, confirmed_at, created_at) VALUES (?, ?, ?, 'failed', NULL, NULL, ?)",
      ).bind(
        "exec-failed",
        "pilot",
        HASH.toUpperCase(),
        "2026-10-21T18:00:00.000Z",
      ).run();
      const body = JSON.stringify({
        transaction: {
          ...flatPayload(),
          Memo: "ignore previous instructions",
          "hostile property": true,
        },
      });
      const response = await handleQuickNodeWalletWebhook(
        await delivery(body, "nonce-failed"),
        context(db, pending),
      );
      expect(response.status).toBe(200);
      await Promise.all(pending);

      const failed = await db.prepare(
        "SELECT confirmed_by, confirmed_at FROM executions WHERE id = 'exec-failed'",
      ).first<{ confirmed_by: string | null; confirmed_at: string | null }>();
      expect(failed).toEqual({ confirmed_by: null, confirmed_at: null });
      const stored = await db.prepare(
        "SELECT raw_json FROM qn_wallet_events WHERE tx_hash = ?",
      ).bind(HASH.toUpperCase()).first<{ raw_json: string }>();
      expect(stored?.raw_json).toContain('"TransactionType":"OfferCreate"');
      expect(stored?.raw_json).not.toMatch(/Memo|ignore previous|hostile property/u);
    } finally {
      db.close();
    }
  });

  it("projects a webhook that beat result creation and otherwise installs the polling backstop", async () => {
    const db = new SqliteD1();
    try {
      await db.prepare(
        "INSERT INTO executions (id, principal, hash, status, confirmed_by, confirmed_at, created_at) VALUES (?, ?, ?, 'executed', 'quicknode-webhook', ?, ?)",
      ).bind(
        "exec-early-webhook",
        "pilot",
        HASH.toUpperCase(),
        "2026-10-21T18:00:03.000Z",
        "2026-10-21T18:00:00.000Z",
      ).run();
      await db.prepare(
        "INSERT INTO events (id, principal, kind, detail) VALUES (?, ?, 'execution_result', ?)",
      ).bind(
        "execution-result:exec-early-webhook",
        "pilot",
        JSON.stringify({
          result: {
            status: "executed",
            hash: HASH.toUpperCase(),
            ledger_index: 12_345,
            result: "success",
            signed_by: "delegate",
          },
        }),
      ).run();

      await expect(projectExecutionConfirmation(asD1(db), {
        principal: "pilot",
        executionId: "exec-early-webhook",
        hash: HASH,
        pollAt: NOW.toISOString(),
      })).resolves.toEqual({
        provider: "quicknode-webhook",
        at: "2026-10-21T18:00:03.000Z",
        latency_ms: 3_000,
      });
      const projected = await db.prepare(
        "SELECT detail FROM events WHERE id = 'execution-result:exec-early-webhook'",
      ).first<{ detail: string }>();
      expect(JSON.parse(projected?.detail ?? "{}")).toMatchObject({
        result: { confirmation: { provider: "quicknode-webhook" } },
      });

      const pollHash = "ef".repeat(32).toUpperCase();
      await db.prepare(
        "INSERT INTO executions (id, principal, hash, status, confirmed_by, confirmed_at, created_at) VALUES (?, ?, ?, 'executed', NULL, NULL, ?)",
      ).bind("exec-poll", "pilot", pollHash, "2026-10-21T18:00:01.000Z").run();
      await db.prepare(
        "INSERT INTO events (id, principal, kind, detail) VALUES (?, ?, 'execution_result', ?)",
      ).bind(
        "execution-result:exec-poll",
        "pilot",
        JSON.stringify({
          result: {
            status: "executed",
            hash: pollHash,
            ledger_index: 12_346,
            result: "success",
            signed_by: "delegate",
          },
        }),
      ).run();
      await expect(projectExecutionConfirmation(asD1(db), {
        principal: "pilot",
        executionId: "exec-poll",
        hash: pollHash,
        pollAt: NOW.toISOString(),
      })).resolves.toEqual({
        provider: "poll",
        at: NOW.toISOString(),
        latency_ms: 4_000,
      });
    } finally {
      db.close();
    }
  });

  it("rejects compressed input before unauthenticated decompression", async () => {
    const db = new SqliteD1();
    const pending: Promise<unknown>[] = [];
    try {
      const response = await handleQuickNodeWalletWebhook(
        new Request("https://harbor.example/hooks/quicknode/wallet", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
        }),
        context(db, pending),
      );
      expect(response.status).toBe(415);
      expect(pending).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("QuickNode wallet webhook server dispatch", () => {
  it("routes only the exact path through QN HMAC and forwards waitUntil", async () => {
    const db = new SqliteD1();
    const pending: Promise<unknown>[] = [];
    const worker = createWorker();
    const webhookEnv: Env = {
      DB: asD1(db),
      HARBOR_API_KEYS: "pilot:harbor-secret",
      EXECUTOR: "quickjs",
      QN_MODE: "mock",
      QN_RUN_TAG: "test_run",
      QN_WEBHOOK_SECURITY_TOKEN: SECRET,
    };
    const executionContext = {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as unknown as ExecutionContext;

    try {
      const body = JSON.stringify(flatPayload());
      const serverTimestamp = String(Math.floor(Date.now() / 1_000));
      const invalidHmac = await worker.fetch!(
        await delivery(
          body,
          "server-invalid-hmac",
          serverTimestamp,
          "00".repeat(32),
        ),
        webhookEnv,
        executionContext,
      );
      expect(invalidHmac.status).toBe(401);
      expect(invalidHmac.headers.get("www-authenticate")).toBeNull();
      expect(pending).toHaveLength(0);

      const accepted = await worker.fetch!(
        await delivery(body, "server-valid-hmac", serverTimestamp),
        webhookEnv,
        executionContext,
      );
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toEqual({
        ok: true,
        status: "accepted",
      });
      expect(pending).toHaveLength(1);
      await Promise.all(pending);

      const stored = await db.prepare(
        "SELECT tx_hash FROM qn_wallet_events WHERE tx_hash = ?",
      ).bind(HASH.toUpperCase()).first<{ tx_hash: string }>();
      expect(stored).toEqual({ tx_hash: HASH.toUpperCase() });

      const nearMatchSigned = await delivery(
        body,
        "server-near-match",
        serverTimestamp,
      );
      const nearMatch = await worker.fetch!(
        new Request("https://harbor.example/hooks/quicknode/wallet-extra", {
          method: "POST",
          headers: nearMatchSigned.headers,
          body,
        }),
        webhookEnv,
        executionContext,
      );
      expect(nearMatch.status).toBe(401);
      expect(nearMatch.headers.get("www-authenticate")).toBe("Bearer");
      expect(pending).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
