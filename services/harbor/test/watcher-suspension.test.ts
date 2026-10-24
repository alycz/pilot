import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";
import type { DelegateSet } from "xrpl";

import {
  createD1WatcherStore,
  parseAccountTxPage,
  runWatcher,
  type WatchedLink,
  type WatcherLedger,
} from "../src/exec/watcher";

const OWNER = "rBudgetOwner";
const DELEGATE = "rHarborDelegate";
const FOREIGN_HASH = "A".repeat(64);
const KNOWN_HASH = "B".repeat(64);
const UNVALIDATED_HASH = "C".repeat(64);

type SqlValue = string | number | bigint | null | ArrayBuffer | Uint8Array;

function d1Result<T>(results: T[], changes = 0): D1Result<T> {
  return {
    success: true,
    results,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: results.length,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes,
    },
  };
}

class SqliteD1Statement {
  private values: SqlValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values as SqlValue[];
    return this;
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.statement().get(...this.values) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return (column === undefined ? row : row[column]) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return d1Result(this.statement().all(...this.values) as T[]);
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.runSync<T>();
  }

  runSync<T = Record<string, unknown>>(): D1Result<T> {
    const result = this.statement().run(...this.values);
    return d1Result<T>([], Number(result.changes));
  }

  private statement(): StatementSync {
    return this.database.prepare(this.sql);
  }
}

class SqliteD1 {
  readonly sqlite = new DatabaseSync(":memory:");

  constructor() {
    this.sqlite.exec(`
      CREATE TABLE links (
        id TEXT PRIMARY KEY,
        principal TEXT NOT NULL,
        owner TEXT NOT NULL,
        network TEXT NOT NULL,
        delegate TEXT NOT NULL,
        status TEXT NOT NULL,
        last_ledger INTEGER,
        revoke_tx TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE executions (
        principal TEXT NOT NULL,
        hash TEXT
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        principal TEXT NOT NULL,
        owner TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite, sql);
  }

  async batch<T = unknown>(statements: SqliteD1Statement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync<T>());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }

  addLink(principal: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO links
          (id, principal, owner, network, delegate, status, last_ledger, revoke_tx, created_at)
         VALUES (?, ?, ?, 'testnet', ?, 'active', 100, NULL, ?)`,
      )
      .run(`link-${principal}`, principal, OWNER, DELEGATE, `2026-01-01T00:00:0${principal === "alpha" ? 0 : 1}.000Z`);
  }

  link(principal: string): Record<string, unknown> {
    return this.sqlite
      .prepare("SELECT status, last_ledger, revoke_tx FROM links WHERE principal = ?")
      .get(principal) as Record<string, unknown>;
  }

  events(): Record<string, unknown>[] {
    return this.sqlite
      .prepare("SELECT id, principal, owner, kind, detail, created_at FROM events ORDER BY id")
      .all() as Record<string, unknown>[];
  }

  close(): void {
    this.sqlite.close();
  }
}

function preparedRevoke(link: WatchedLink): DelegateSet {
  return {
    TransactionType: "DelegateSet",
    Account: link.owner,
    Authorize: link.delegate,
    Permissions: [],
    Fee: "12",
    Sequence: 7,
    LastLedgerSequence: 140,
  };
}

describe("foreign delegated transaction watcher", () => {
  it("suspends once, records a foreign event and prepared revoke, and ignores known hashes", async () => {
    const database = new SqliteD1();
    try {
      database.addLink("alpha");
      database.addLink("beta");
      database.sqlite
        .prepare("INSERT INTO executions (principal, hash) VALUES (?, ?)")
        .run("beta", KNOWN_HASH);

      const preparedFor: string[] = [];
      const ledger: WatcherLedger = {
        async accountTransactions(link) {
          return parseAccountTxPage(
            {
              ledger_index_max: 120,
              transactions:
                link.principal === "alpha"
                  ? [
                      {
                        validated: true,
                        hash: FOREIGN_HASH,
                        ledger_index: 110,
                        tx_json: {
                          TransactionType: "OfferCreate",
                          Account: OWNER,
                          Delegate: DELEGATE,
                        },
                      },
                    ]
                  : [
                      {
                        validated: true,
                        hash: KNOWN_HASH,
                        ledger_index: 111,
                        tx_json: {
                          TransactionType: "OfferCancel",
                          Account: OWNER,
                          Delegate: DELEGATE,
                        },
                      },
                      {
                        validated: false,
                        hash: UNVALIDATED_HASH,
                        ledger_index: 112,
                        tx_json: {
                          TransactionType: "OfferCreate",
                          Account: OWNER,
                          Delegate: DELEGATE,
                        },
                      },
                    ],
            },
            link.owner,
          );
        },
        async prepareRevoke(link) {
          preparedFor.push(link.principal);
          return preparedRevoke(link);
        },
      };

      let nextEvent = 0;
      const options = {
        db: database.asD1(),
        ledger,
        now: () => new Date("2026-01-02T03:04:05.000Z"),
        randomUUID: () => `event-${++nextEvent}`,
      };
      const first = await runWatcher(options);

      expect(first).toEqual({
        linksScanned: 2,
        linksSuspended: 1,
        eventsInserted: 1,
        linksAdvanced: 1,
        linksSkipped: 0,
        linksFailed: 0,
      });
      expect(preparedFor).toEqual(["alpha"]);
      expect(database.link("alpha")).toEqual({
        status: "suspended",
        last_ledger: 120,
        revoke_tx: JSON.stringify(preparedRevoke({
          id: "link-alpha",
          principal: "alpha",
          owner: OWNER,
          network: "testnet",
          delegate: DELEGATE,
          status: "active",
          lastLedger: 100,
        })),
      });
      expect(database.link("beta")).toEqual({
        status: "active",
        last_ledger: 120,
        revoke_tx: null,
      });

      const events = database.events();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: "event-1",
        principal: "alpha",
        owner: OWNER,
        kind: "foreign",
        created_at: "2026-01-02T03:04:05.000Z",
      });
      expect(JSON.parse(String(events[0].detail))).toEqual({
        hash: FOREIGN_HASH,
        ledger_index: 110,
        transaction_type: "OfferCreate",
        delegate: DELEGATE,
      });

      const store = createD1WatcherStore(database.asD1());
      const staleLink: WatchedLink = {
        id: "link-alpha",
        principal: "alpha",
        owner: OWNER,
        network: "testnet",
        delegate: DELEGATE,
        status: "active",
        lastLedger: 100,
      };
      const staleAttempt = await store.quarantine(
        staleLink,
        [{
          hash: UNVALIDATED_HASH,
          ledgerIndex: 121,
          transactionType: "OfferCreate",
          delegate: DELEGATE,
        }],
        preparedRevoke(staleLink),
        121,
        ["event-stale"],
        "2026-01-02T03:05:05.000Z",
      );
      expect(staleAttempt).toEqual({ quarantined: false, eventsInserted: 0 });

      const second = await runWatcher(options);
      expect(second.linksSuspended).toBe(0);
      expect(second.eventsInserted).toBe(0);
      expect(database.events()).toHaveLength(1);
      expect(preparedFor).toEqual(["alpha"]);
    } finally {
      database.close();
    }
  });

  it("keeps a locally suspended revoke under watch until ledger-confirmed revocation", async () => {
    const database = new SqliteD1();
    try {
      database.addLink("alpha");
      database.sqlite
        .prepare("UPDATE links SET status = 'suspended', revoke_tx = ? WHERE principal = ?")
        .run(JSON.stringify({ TransactionType: "DelegateSet", Permissions: [] }), "alpha");
      let preparationAttempts = 0;
      let ledgerMax = 130;
      const options = {
        db: database.asD1(),
        ledger: {
          async accountTransactions(link) {
            return parseAccountTxPage(
              {
                ledger_index_max: ledgerMax,
                transactions: [{
                  validated: true,
                  hash: FOREIGN_HASH,
                  ledger_index: 125,
                  tx_json: {
                    TransactionType: "OfferCreate",
                    Account: OWNER,
                    Delegate: DELEGATE,
                  },
                }],
              },
              link.owner,
            );
          },
          async prepareRevoke() {
            preparationAttempts += 1;
            throw new Error("must not replace an owner-reviewed revoke");
          },
        },
        now: () => new Date("2026-01-02T03:04:05.000Z"),
        randomUUID: () => "event-suspended",
      };
      const result = await runWatcher(options);

      expect(result).toEqual({
        linksScanned: 1,
        linksSuspended: 0,
        eventsInserted: 1,
        linksAdvanced: 0,
        linksSkipped: 0,
        linksFailed: 0,
      });
      expect(preparationAttempts).toBe(0);
      expect(database.link("alpha")).toEqual({
        status: "suspended",
        last_ledger: 130,
        revoke_tx: JSON.stringify({ TransactionType: "DelegateSet", Permissions: [] }),
      });
      expect(database.events()).toHaveLength(1);

      ledgerMax = 140;
      const repeated = await runWatcher(options);
      expect(repeated.eventsInserted).toBe(0);
      expect(database.link("alpha")).toMatchObject({ last_ledger: 140 });
      expect(database.events()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("quarantines even when revoke preparation is unavailable", async () => {
    const database = new SqliteD1();
    try {
      database.addLink("alpha");
      let preparationAttempts = 0;
      const ledger: WatcherLedger = {
        async accountTransactions(link) {
          return parseAccountTxPage(
            {
              ledger_index_max: 120,
              transactions: [
                {
                  validated: true,
                  hash: FOREIGN_HASH,
                  ledger_index: 110,
                  tx_json: {
                    TransactionType: "OfferCreate",
                    Account: OWNER,
                    Delegate: DELEGATE,
                  },
                },
              ],
            },
            link.owner,
          );
        },
        async prepareRevoke() {
          preparationAttempts += 1;
          throw new Error("revoke preparation service unavailable");
        },
      };

      const result = await runWatcher({
        db: database.asD1(),
        ledger,
        now: () => new Date("2026-01-02T03:04:05.000Z"),
        randomUUID: () => "event-fail-open",
      });

      expect(preparationAttempts).toBe(1);
      expect(result.linksScanned).toBe(1);
      expect(result.linksSuspended).toBe(1);
      expect(result.eventsInserted).toBe(1);
      expect(result.linksFailed).toBe(0);
      expect(database.link("alpha")).toEqual({
        status: "suspended",
        last_ledger: 120,
        revoke_tx: null,
      });
      expect(database.events()).toEqual([
        expect.objectContaining({
          id: "event-fail-open",
          principal: "alpha",
          owner: OWNER,
          kind: "foreign",
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it("fails the scan without advancing past a malformed validated entry", async () => {
    const database = new SqliteD1();
    try {
      database.addLink("alpha");
      const result = await runWatcher({
        db: database.asD1(),
        ledger: {
          async accountTransactions(link) {
            return parseAccountTxPage(
              {
                ledger_index_max: 120,
                transactions: [
                  {
                    validated: true,
                    hash: FOREIGN_HASH,
                    ledger_index: 110,
                    tx_json: {
                      TransactionType: "OfferCreate",
                      Account: OWNER,
                      Delegate: 7,
                    },
                  },
                ],
              },
              link.owner,
            );
          },
          async prepareRevoke(link) {
            return preparedRevoke(link);
          },
        },
      });

      expect(result).toMatchObject({
        linksScanned: 1,
        linksSuspended: 0,
        linksAdvanced: 0,
        linksFailed: 1,
      });
      expect(database.link("alpha")).toEqual({
        status: "active",
        last_ledger: 100,
        revoke_tx: null,
      });
      expect(database.events()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
