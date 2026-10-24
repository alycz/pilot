import { readFile } from "node:fs/promises";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  handleQuickNodeWatchdog,
  type QuickNodeWatchdogContext,
} from "../src/rest";
import {
  parseWatchdogStreamPayload,
  processQuickNodeWatchdog,
  readQuickNodeWatchdogEvents,
  type WatchdogPayerAuthority,
  type WatchdogRegistry,
} from "../src/quicknode/watchdog";
import {
  createWatchdogPayerAuthority,
  createWorker,
  type Env,
} from "../src/server";
import { runQuickNodeFilter } from "../tools/qn-local/src/filter";
import type { QnLocalStore } from "../tools/qn-local/src/store";

const SECRET = "quicknode-stream-fixture-secret";
const NOW = new Date("2026-10-21T19:00:05.000Z");
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const DELEGATE = "rJdYtgaiEgzL7xD2QdPKg5xoHkWc7CZjvm";
const PAYER = "rQhUcbJoDfvgXr1EkMwarLP5QT3XinEBDg";
const ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const RLUSD_HEX = "524C555344000000000000000000000000000000";
const HASH_HARBOR = "11".repeat(32);
const HASH_ROGUE = "22".repeat(32);
const HASH_OWNER = "33".repeat(32);
const HASH_PAYER = "44".repeat(32);
const HASH_PAYER_ROGUE = "55".repeat(32);

const SCHEMA = `
CREATE TABLE qn_nonces (nonce TEXT PRIMARY KEY, received_at TEXT NOT NULL);
CREATE TABLE links (
  id TEXT PRIMARY KEY, principal TEXT NOT NULL, owner TEXT NOT NULL,
  network TEXT NOT NULL, delegate TEXT NOT NULL, status TEXT NOT NULL,
  revoke_tx TEXT, frozen_at TEXT, frozen_reason TEXT, created_at TEXT NOT NULL
);
CREATE TABLE executions (id TEXT PRIMARY KEY, hash TEXT);
CREATE TABLE qn_watchdog_events (
  tx_hash TEXT PRIMARY KEY, account TEXT NOT NULL, delegate TEXT,
  class TEXT NOT NULL, flags_json TEXT NOT NULL, ledger_index INTEGER NOT NULL,
  close_time TEXT NOT NULL, action TEXT NOT NULL, received_at TEXT NOT NULL
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
CREATE TABLE x402_payers (
  network TEXT NOT NULL, payer TEXT NOT NULL, status TEXT NOT NULL,
  funded_ledger_index INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (network, payer)
);
CREATE TABLE x402_payments (hash TEXT);
CREATE TABLE ap4m_purchase_attempts (tx_hash TEXT);
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

class MemoryQnStore implements QnLocalStore {
  readonly lists = new Map<string, string[]>();
  readonly reads = new Map<string, number>();

  async putList(key: string, items: string[]): Promise<string[]> {
    const next = [...new Set(items)];
    this.lists.set(key, next);
    return next;
  }

  async patchList(key: string, addItems: string[], removeItems: string[]): Promise<string[]> {
    const removed = new Set(removeItems);
    const next = [...new Set([...(this.lists.get(key) ?? []), ...addItems])]
      .filter((item) => !removed.has(item));
    this.lists.set(key, next);
    return next;
  }

  async getList(key: string): Promise<string[] | undefined> {
    this.reads.set(key, (this.reads.get(key) ?? 0) + 1);
    return this.lists.get(key);
  }

  async deleteList(key: string): Promise<boolean> {
    return this.lists.delete(key);
  }

  async putValue(): Promise<void> {}

  async getValue(): Promise<unknown> {
    return undefined;
  }
}

function event(
  hash: string,
  account: string,
  delegate: string | null,
  flags: string[] = [],
): Record<string, unknown> {
  return {
    tx_hash: hash,
    account,
    delegate,
    tx_type: "Payment",
    result: "tesSUCCESS",
    ledger_index: 12_345,
    close_time: "2026-10-21T19:00:00.000Z",
    flags,
  };
}

async function seedLink(db: SqliteD1): Promise<void> {
  await db.prepare(
    `INSERT INTO links
      (id, principal, owner, network, delegate, status, revoke_tx, frozen_at,
       frozen_reason, created_at)
     VALUES ('link-1', 'pilot', ?, 'testnet', ?, 'active', NULL, NULL, NULL, ?)`,
  ).bind(OWNER, DELEGATE, "2026-10-21T18:59:00.000Z").run();
  await db.prepare("INSERT INTO executions (id, hash) VALUES ('exec-1', ?)")
    .bind(HASH_HARBOR).run();
}

async function signature(nonce: string, timestamp: string, body: string): Promise<string> {
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
  return new Request("https://harbor.example/hooks/quicknode/watchdog", {
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

function routeContext(
  db: SqliteD1,
  pending: Promise<unknown>[],
  registry: WatchdogRegistry = {
    freeze: async () => ({ ok: true, skipped: false }),
  },
  payer: WatchdogPayerAuthority = {
    activationFloor: async () => undefined,
    ownsTransaction: async () => false,
    disable: async () => false,
  },
): QuickNodeWatchdogContext {
  return {
    db: asD1(db),
    env: {
      EXEC_NETWORK: "testnet",
      QN_MODE: "mock",
      QN_RUN_TAG: "test_run",
      QN_STREAM_SECURITY_TOKEN: SECRET,
      QN_WATCHDOG_ACTION: "freeze",
    },
    now: NOW,
    waitUntil: (promise) => pending.push(promise),
    registry,
    payer,
  };
}

describe("QuickNode watchdog filter", () => {
  it("emits only watched transactions with deterministic flags and failed results", async () => {
    const template = await readFile(new URL("../quicknode/filters/watchdog.js", import.meta.url), "utf8");
    const source = template.replaceAll("__NET__", "testnet").replaceAll("__RUN__", "test_run");
    const store = new MemoryQnStore();
    store.lists.set("harbor_testnet_test_run_accounts", [OWNER]);
    store.lists.set("harbor_testnet_test_run_delegates", [DELEGATE]);
    store.lists.set("harbor_testnet_test_run_frozen", [OWNER]);
    store.lists.set("harbor_testnet_test_run_tx_types", ["Payment"]);
    store.lists.set("harbor_testnet_test_run_issuers", [`RLUSD.${ISSUER}`]);
    const iouFields = [
      "Amount",
      "SendMax",
      "TakerGets",
      "TakerPays",
      "Amount2",
      "LimitAmount",
    ] as const;
    const rogueTransactions = iouFields.map((field, index) => ({
      hash: (0x22 + index).toString(16).padStart(2, "0").repeat(32),
      Account: OWNER,
      Delegate: DELEGATE,
      TransactionType: "TrustSet",
      [field]: { currency: "USD", issuer: PAYER, value: "1" },
      metaData: { TransactionResult: "tesSUCCESS" },
    }));

    const result = await runQuickNodeFilter(source, {
      data: {
        ledger_index: 12_345,
        close_time_iso: "2026-10-21T19:00:00.000Z",
        transactions: [
          {
            hash: HASH_HARBOR,
            Account: OWNER,
            Delegate: DELEGATE,
            TransactionType: "Payment",
            Amount: { currency: RLUSD_HEX, issuer: ISSUER, value: "1" },
            metaData: { TransactionResult: "tecPATH_DRY" },
          },
          ...rogueTransactions,
          {
            hash: HASH_OWNER,
            Account: PAYER,
            TransactionType: "Payment",
            metaData: { TransactionResult: "tesSUCCESS" },
          },
        ],
      },
    }, store) as { events: Array<Record<string, unknown>> };

    expect(result.events).toHaveLength(7);
    expect(result.events[0]).toMatchObject({
      tx_hash: HASH_HARBOR,
      result: "tecPATH_DRY",
      flags: ["frozen_account"],
    });
    for (const [index, candidate] of result.events.slice(1).entries()) {
      expect(candidate).toMatchObject({
        tx_hash: rogueTransactions[index]?.hash.toUpperCase(),
        flags: ["frozen_account", "tx_type_not_delegated", "issuer_not_allowlisted"],
      });
    }
    expect(parseWatchdogStreamPayload({
      events: [{ ...event(HASH_OWNER, OWNER, null), result: "unknown" }],
    }).events[0]?.result).toBe("unknown");
    expect(Object.fromEntries(store.reads)).toEqual({
      harbor_testnet_test_run_accounts: 1,
      harbor_testnet_test_run_delegates: 1,
      harbor_testnet_test_run_frozen: 1,
      harbor_testnet_test_run_tx_types: 1,
      harbor_testnet_test_run_issuers: 1,
    });

    store.reads.clear();
    const empty = await runQuickNodeFilter(source, {
      data: { transactions: [{
        hash: HASH_OWNER,
        Account: PAYER,
        TransactionType: "Payment",
        metaData: { TransactionResult: "tesSUCCESS" },
      }] },
    }, store);
    expect(empty).toBeNull();
    expect(Object.fromEntries(store.reads)).toEqual({
      harbor_testnet_test_run_accounts: 1,
    });

    await expect(runQuickNodeFilter(source, {
      data: {
        transactions: Array.from({ length: 257 }, (_, index) => ({
          hash: index.toString(16).padStart(64, "0"),
          Account: OWNER,
          TransactionType: "Payment",
          metaData: { TransactionResult: "tesSUCCESS" },
        })),
      },
    }, store)).rejects.toThrow("watchdog transaction batch too large");
  });
});

describe("QuickNode watchdog authority", () => {
  it("ignores pre-activation history but accepts unseen post-link events out of order", async () => {
    const db = new SqliteD1();
    const frozen: string[] = [];
    const registry: WatchdogRegistry = {
      freeze: async (_network, account) => {
        frozen.push(account);
        return { ok: true, skipped: false };
      },
    };
    try {
      await seedLink(db);
      const historical = {
        ...event("99".repeat(32), OWNER, DELEGATE),
        ledger_index: 12_300,
        close_time: "2026-10-21T18:58:59.000Z",
      };
      const stale = await processQuickNodeWatchdog(asD1(db), {
        events: [historical],
      }, {
        receivedAt: NOW.toISOString(),
        network: "testnet",
        action: "freeze",
        runTag: "test_run",
        registry,
      });
      expect(stale).toMatchObject({ events: [], inserted: 0, newlyFrozen: 0 });
      expect(frozen).toEqual([]);

      const watermark = await processQuickNodeWatchdog(asD1(db), {
        events: [{
          ...event(HASH_HARBOR, OWNER, DELEGATE),
          ledger_index: 12_350,
        }],
      }, {
        receivedAt: NOW.toISOString(),
        network: "testnet",
        action: "freeze",
        runTag: "test_run",
        registry,
      });
      expect(watermark).toMatchObject({ inserted: 1, newlyFrozen: 0 });

      const postLinkOutOfOrder = {
        ...event("AA".repeat(32), OWNER, DELEGATE),
        ledger_index: 12_301,
        close_time: "2026-10-21T18:59:01.000Z",
      };
      const current = await processQuickNodeWatchdog(asD1(db), {
        events: [postLinkOutOfOrder],
      }, {
        receivedAt: NOW.toISOString(),
        network: "testnet",
        action: "freeze",
        runTag: "test_run",
        registry,
      });
      expect(current).toMatchObject({ inserted: 1, newlyFrozen: 1 });
      expect(current.events[0]).toMatchObject({
        tx_hash: "AA".repeat(32),
        class: "out_of_band_delegate",
        action: "frozen",
      });
      expect(frozen).toEqual([OWNER]);
    } finally {
      db.close();
    }
  });

  it("uses the payer funding ledger as its activation floor", async () => {
    const db = new SqliteD1();
    const disabled: string[] = [];
    const payer: WatchdogPayerAuthority = {
      activationFloor: async (account) => account === PAYER
        ? { ledgerIndex: 12_346, activatedAt: "2026-10-21T18:59:00.000Z" }
        : undefined,
      ownsTransaction: async () => false,
      disable: async (account) => {
        disabled.push(account);
        return true;
      },
    };
    try {
      const historical = await processQuickNodeWatchdog(asD1(db), {
        events: [event("BB".repeat(32), PAYER, null)],
      }, {
        receivedAt: NOW.toISOString(),
        network: "testnet",
        action: "freeze",
        runTag: "test_run",
        payer,
      });
      expect(historical).toMatchObject({ events: [], inserted: 0, newlyFrozen: 0 });
      expect(disabled).toEqual([]);

      const activated = await processQuickNodeWatchdog(asD1(db), {
        events: [{
          ...event("CC".repeat(32), PAYER, null),
          ledger_index: 12_346,
        }],
      }, {
        receivedAt: NOW.toISOString(),
        network: "testnet",
        action: "freeze",
        runTag: "test_run",
        payer,
      });
      expect(activated).toMatchObject({ inserted: 1, newlyFrozen: 1 });
      expect(disabled).toEqual([PAYER]);
    } finally {
      db.close();
    }
  });

  it("reads only principal-owned events and projects the fixed next step", async () => {
    const db = new SqliteD1();
    try {
      await seedLink(db);
      await processQuickNodeWatchdog(asD1(db), {
        events: [event(HASH_ROGUE, OWNER, DELEGATE)],
      }, {
        receivedAt: NOW.toISOString(),
        network: "testnet",
        action: "freeze",
        runTag: "test_run",
      });
      await db.prepare(
        `INSERT INTO qn_watchdog_events
          (tx_hash, account, delegate, class, flags_json, ledger_index,
           close_time, action, received_at)
         VALUES (?, ?, NULL, 'owner', '[]', 12345, ?, 'none', ?)`,
      ).bind(HASH_PAYER, PAYER, NOW.toISOString(), NOW.toISOString()).run();

      await expect(readQuickNodeWatchdogEvents(
        asD1(db),
        "pilot",
        undefined,
        20,
      )).resolves.toEqual([
        expect.objectContaining({
          tx_hash: HASH_ROGUE,
          account: OWNER,
          next_step: "owner_revoke_onledger",
        }),
      ]);
      await expect(readQuickNodeWatchdogEvents(
        asD1(db),
        "another-principal",
        undefined,
        20,
      )).resolves.toEqual([]);
    } finally {
      db.close();
    }
  });

  it("classifies the matrix, freezes only violations, and is idempotent", async () => {
    const db = new SqliteD1();
    const frozen: string[] = [];
    const disabled: string[] = [];
    const registry: WatchdogRegistry = {
      freeze: async (_network, account) => {
        frozen.push(account);
        return { ok: true, skipped: false };
      },
    };
    const payer: WatchdogPayerAuthority = {
      activationFloor: async (account) => account === PAYER
        ? { ledgerIndex: 12_000, activatedAt: "2026-10-21T18:59:00.000Z" }
        : undefined,
      ownsTransaction: async (hash) => hash === HASH_PAYER,
      disable: async (account) => {
        disabled.push(account);
        return true;
      },
    };
    try {
      await seedLink(db);
      const payload = { events: [
        event(HASH_HARBOR, OWNER, DELEGATE),
        event(HASH_ROGUE, OWNER, DELEGATE, ["tx_type_not_delegated"]),
        event(HASH_OWNER, OWNER, null),
        event(HASH_PAYER, PAYER, null),
        event(HASH_PAYER_ROGUE, PAYER, null),
      ] };
      const first = await processQuickNodeWatchdog(asD1(db), payload, {
        receivedAt: NOW.toISOString(),
        network: "testnet",
        action: "freeze",
        runTag: "test_run",
        registry,
        payer,
      });

      expect(first.events.map(({ tx_hash, class: classification, action }) => ({
        tx_hash,
        classification,
        action,
      }))).toEqual([
        { tx_hash: HASH_HARBOR, classification: "harbor", action: "none" },
        { tx_hash: HASH_ROGUE, classification: "out_of_band_delegate", action: "frozen" },
        { tx_hash: HASH_OWNER, classification: "owner", action: "none" },
        { tx_hash: HASH_PAYER, classification: "harbor", action: "none" },
        { tx_hash: HASH_PAYER_ROGUE, classification: "out_of_band_payer", action: "frozen" },
      ]);
      expect(first).toMatchObject({ inserted: 5, newlyFrozen: 2 });
      expect(frozen).toEqual([OWNER, PAYER]);
      expect(disabled).toEqual([PAYER]);
      await expect(db.prepare(
        "SELECT frozen_reason FROM links WHERE id = 'link-1'",
      ).first("frozen_reason")).resolves.toBe(`quicknode:${HASH_ROGUE}`);

      const second = await processQuickNodeWatchdog(asD1(db), payload, {
        receivedAt: NOW.toISOString(),
        network: "testnet",
        action: "freeze",
        runTag: "test_run",
        registry,
        payer,
      });
      expect(second).toMatchObject({ inserted: 0, newlyFrozen: 0 });
      expect(frozen).toEqual([OWNER, PAYER]);
      expect(disabled).toEqual([PAYER]);
      const counters = await db.prepare(
        `SELECT watchdog_ledgers_seen, watchdog_events, watchdog_frozen_count
           FROM qn_rpc_counters WHERE run_tag = 'test_run'`,
      ).first<Record<string, number>>();
      expect(counters).toEqual({
        watchdog_ledgers_seen: 2,
        watchdog_events: 5,
        watchdog_frozen_count: 2,
      });
    } finally {
      db.close();
    }
  });

  it("records alert mode without freezing and rejects unbounded/raw shapes", async () => {
    const db = new SqliteD1();
    try {
      await seedLink(db);
      const result = await processQuickNodeWatchdog(asD1(db), {
        events: [event(HASH_ROGUE, OWNER, DELEGATE)],
      }, {
        receivedAt: NOW.toISOString(),
        network: "testnet",
        action: "alert",
        runTag: "test_run",
      });
      expect(result.events[0]).toMatchObject({
        class: "out_of_band_delegate",
        action: "alerted",
      });
      await expect(db.prepare(
        "SELECT frozen_at FROM links WHERE id = 'link-1'",
      ).first("frozen_at")).resolves.toBeNull();

      const recovered = await processQuickNodeWatchdog(asD1(db), {
        events: [event(HASH_ROGUE, OWNER, DELEGATE)],
      }, {
        receivedAt: NOW.toISOString(),
        network: "testnet",
        action: "freeze",
        runTag: "test_run",
      });
      expect(recovered.events[0]).toMatchObject({
        class: "out_of_band_delegate",
        action: "frozen",
      });
      expect(recovered).toMatchObject({ inserted: 0, newlyFrozen: 1 });
      expect(() => parseWatchdogStreamPayload({
        events: [{ ...event(HASH_OWNER, OWNER, null), raw: "hostile" }],
      })).toThrow();
      expect(() => parseWatchdogStreamPayload({ events: [] })).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("QuickNode watchdog route", () => {
  it("authenticates before a fast acknowledgement and schedules durable work", async () => {
    const db = new SqliteD1();
    const pending: Promise<unknown>[] = [];
    const registry: WatchdogRegistry = {
      freeze: async () => ({ ok: true, skipped: false }),
    };
    try {
      await seedLink(db);
      const body = JSON.stringify({ events: [event(HASH_ROGUE, OWNER, DELEGATE)] });
      const response = await handleQuickNodeWatchdog(
        await delivery(body, "watchdog-1"),
        routeContext(db, pending, registry),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, status: "accepted" });
      expect(pending).toHaveLength(1);
      await Promise.all(pending);
      await expect(db.prepare(
        "SELECT class, action FROM qn_watchdog_events WHERE tx_hash = ?",
      ).bind(HASH_ROGUE).first()).resolves.toEqual({
        class: "out_of_band_delegate",
        action: "frozen",
      });
    } finally {
      db.close();
    }
  });

  it("rejects tampered, stale, invalid, and replayed deliveries", async () => {
    const db = new SqliteD1();
    const pending: Promise<unknown>[] = [];
    try {
      await seedLink(db);
      const body = JSON.stringify({ events: [event(HASH_ROGUE, OWNER, DELEGATE)] });
      const tampered = await handleQuickNodeWatchdog(
        await delivery(body, "watchdog-tampered", undefined, "00".repeat(32)),
        routeContext(db, pending),
      );
      expect(tampered.status).toBe(401);

      const staleAt = String(Math.floor(NOW.getTime() / 1_000) - 301);
      const stale = await handleQuickNodeWatchdog(
        await delivery(body, "watchdog-stale", staleAt),
        routeContext(db, pending),
      );
      expect(stale.status).toBe(401);

      const invalidBody = JSON.stringify({ events: [{ raw: "hostile" }] });
      const invalid = await handleQuickNodeWatchdog(
        await delivery(invalidBody, "watchdog-invalid"),
        routeContext(db, pending),
      );
      expect(invalid.status).toBe(400);

      const first = await handleQuickNodeWatchdog(
        await delivery(body, "watchdog-replay"),
        routeContext(db, pending),
      );
      expect(first.status).toBe(200);
      await Promise.all(pending);
      const replay = await handleQuickNodeWatchdog(
        await delivery(body, "watchdog-replay"),
        routeContext(db, pending),
      );
      await expect(replay.json()).resolves.toEqual({ ok: true, status: "dup" });
      expect(pending).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("fails closed for unavailable configuration, oversized bodies, and gzip", async () => {
    const db = new SqliteD1();
    const pending: Promise<unknown>[] = [];
    try {
      const body = JSON.stringify({ events: [event(HASH_ROGUE, OWNER, DELEGATE)] });
      const unavailableContext = routeContext(db, pending);
      unavailableContext.env.QN_STREAM_SECURITY_TOKEN = undefined;
      const unavailable = await handleQuickNodeWatchdog(
        await delivery(body, "watchdog-unavailable"),
        unavailableContext,
      );
      expect(unavailable.status).toBe(503);

      const missingDependency = {
        ...routeContext(db, pending),
        registry: undefined,
      } as unknown as QuickNodeWatchdogContext;
      const dependencyFailure = await handleQuickNodeWatchdog(
        await delivery(body, "watchdog-missing-dependency"),
        missingDependency,
      );
      expect(dependencyFailure.status).toBe(503);

      const oversized = await handleQuickNodeWatchdog(
        new Request("https://harbor.example/hooks/quicknode/watchdog", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": "1048577",
          },
          body: "{}",
        }),
        routeContext(db, pending),
      );
      expect(oversized.status).toBe(413);

      const gzip = await handleQuickNodeWatchdog(
        new Request("https://harbor.example/hooks/quicknode/watchdog", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
        }),
        routeContext(db, pending),
      );
      expect(gzip.status).toBe(415);
      expect(pending).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("QuickNode watchdog server seam", () => {
  it("recognizes both payment rails and disables only the configured-network payer", async () => {
    const db = new SqliteD1();
    const x402Hash = "66".repeat(32);
    const ap4mHash = "77".repeat(32);
    try {
      await db.prepare(
        `INSERT INTO x402_payers
          (network, payer, status, funded_ledger_index, created_at, updated_at)
         VALUES (?, ?, 'ready', ?, ?, ?)`,
      ).bind("testnet", PAYER, 12_000, "2026-10-21T18:59:00.000Z", NOW.toISOString()).run();
      await db.prepare(
        `INSERT INTO x402_payers
          (network, payer, status, funded_ledger_index, created_at, updated_at)
         VALUES (?, ?, 'ready', ?, ?, ?)`,
      ).bind("devnet", PAYER, 12_100, "2026-10-21T18:59:30.000Z", NOW.toISOString()).run();
      await db.prepare("INSERT INTO x402_payments (hash) VALUES (?)")
        .bind(x402Hash).run();
      await db.prepare("INSERT INTO ap4m_purchase_attempts (tx_hash) VALUES (?)")
        .bind(ap4mHash).run();

      const authority = createWatchdogPayerAuthority(asD1(db), "testnet");
      await expect(authority.activationFloor(PAYER, "testnet")).resolves.toEqual({
        ledgerIndex: 12_000,
        activatedAt: "2026-10-21T18:59:00.000Z",
      });
      await expect(authority.activationFloor(OWNER, "testnet")).resolves.toBeUndefined();
      await expect(authority.ownsTransaction(x402Hash)).resolves.toBe(true);
      await expect(authority.ownsTransaction(ap4mHash)).resolves.toBe(true);
      await expect(authority.ownsTransaction("88".repeat(32))).resolves.toBe(false);
      await expect(authority.disable(
        PAYER,
        `quicknode:${HASH_PAYER_ROGUE}`,
        "2026-10-21T19:01:00.000Z",
      )).resolves.toBe(true);
      await expect(authority.disable(
        PAYER,
        `quicknode:${HASH_PAYER_ROGUE}`,
        "2026-10-21T19:02:00.000Z",
      )).resolves.toBe(false);

      await expect(db.prepare(
        "SELECT network, status, updated_at FROM x402_payers ORDER BY network",
      ).all()).resolves.toMatchObject({ results: [
        { network: "devnet", status: "ready", updated_at: NOW.toISOString() },
        {
          network: "testnet",
          status: "disabled",
          updated_at: "2026-10-21T19:01:00.000Z",
        },
      ] });
    } finally {
      db.close();
    }
  });

  it("routes only the exact pre-auth path through QN HMAC and forwards waitUntil", async () => {
    const db = new SqliteD1();
    const pending: Promise<unknown>[] = [];
    const worker = createWorker();
    const env: Env = {
      DB: asD1(db),
      HARBOR_API_KEYS: "pilot:harbor-secret",
      EXECUTOR: "quickjs",
      EXEC_NETWORK: "testnet",
      QN_MODE: "mock",
      QN_RUN_TAG: "test_run",
      QN_STREAM_SECURITY_TOKEN: SECRET,
      QN_WATCHDOG_ACTION: "alert",
    };
    const executionContext = {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as unknown as ExecutionContext;

    try {
      await seedLink(db);
      const body = JSON.stringify({
        events: [event(HASH_ROGUE, OWNER, DELEGATE, ["tx_type_not_delegated"])],
      });
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const invalid = await worker.fetch!(
        await delivery(body, "server-watchdog-invalid", timestamp, "00".repeat(32)),
        env,
        executionContext,
      );
      expect(invalid.status).toBe(401);
      expect(invalid.headers.get("www-authenticate")).toBeNull();
      expect(pending).toHaveLength(0);

      const accepted = await worker.fetch!(
        await delivery(body, "server-watchdog-valid", timestamp),
        env,
        executionContext,
      );
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toEqual({ ok: true, status: "accepted" });
      expect(pending).toHaveLength(1);
      await Promise.all(pending);
      await expect(db.prepare(
        "SELECT class, action FROM qn_watchdog_events WHERE tx_hash = ?",
      ).bind(HASH_ROGUE).first()).resolves.toEqual({
        class: "out_of_band_delegate",
        action: "alerted",
      });

      const nearMatchSigned = await delivery(body, "server-watchdog-near", timestamp);
      const nearMatch = await worker.fetch!(
        new Request("https://harbor.example/hooks/quicknode/watchdog-extra", {
          method: "POST",
          headers: nearMatchSigned.headers,
          body,
        }),
        env,
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
