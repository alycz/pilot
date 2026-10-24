import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  AccountSequenceLeaseAuthority,
  accountSequenceIdentity,
} from "../src/exec/account-sequence-lease";

const ACCOUNT = "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn";
const NOW = "2026-10-22T01:00:00.000Z";
const LATER = "2026-10-22T01:01:00.000Z";
const HASH = "C".repeat(64);

type SqlValue = string | number | bigint | null | Uint8Array;
class Statement {
  private values: SqlValue[] = [];
  constructor(private readonly statement: StatementSync) {}
  bind(...values: unknown[]): this {
    this.values = values as SqlValue[];
    return this;
  }
  async run(): Promise<D1Result> {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } as D1Result["meta"] };
  }
  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }
}
class Database {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor() {
    this.sqlite.exec(readFileSync(new URL("../migrations/0011_autonomous_strategies.sql", import.meta.url), "utf8"));
  }
  prepare(sql: string): Statement { return new Statement(this.sqlite.prepare(sql)); }
  close(): void { this.sqlite.close(); }
}
function d1(database: Database): D1Database { return database as unknown as D1Database; }

describe("AccountSequenceLeaseAuthority", () => {
  it("serializes one ledger account across principals and producers", async () => {
    const database = new Database();
    try {
      const authority = new AccountSequenceLeaseAuthority(d1(database));
      const [manual, strategy] = await Promise.all([
        authority.acquire({ principal: "tenant:a", network: "testnet", account: ACCOUNT,
          source: "manual", attemptId: "manual:1", token: "A".repeat(64), at: NOW }),
        authority.acquire({ principal: "tenant:b", network: "testnet", account: ACCOUNT,
          source: "strategy", attemptId: "strategy:1", token: "B".repeat(64), at: NOW }),
      ]);
      expect(manual.outcome === "acquired" || strategy.outcome === "acquired").toBe(true);
      expect([manual.outcome, strategy.outcome].sort()).toEqual(["acquired", "blocked"]);
      expect(await authority.get({ network: "testnet", account: ACCOUNT })).toMatchObject({
        state: "preparing",
      });
      const owner = manual.outcome === "acquired" ? manual : strategy;
      const collision = await authority.acquire({
        principal: owner.lease.principal === "tenant:a" ? "tenant:b" : "tenant:a",
        network: "testnet", account: ACCOUNT, source: owner.lease.source,
        attemptId: owner.lease.attemptId, token: "D".repeat(64), at: NOW,
      });
      expect(collision.outcome).toBe("blocked");
      expect(collision.lease.principal).toBe(owner.lease.principal);
    } finally { database.close(); }
  });

  it("fences stale tokens and never reclaims a signing or ambiguous lease", async () => {
    const database = new Database();
    try {
      const authority = new AccountSequenceLeaseAuthority(d1(database));
      const acquired = await authority.acquire({ principal: "tenant:a", network: "testnet", account: ACCOUNT,
        source: "strategy", attemptId: "strategy:1", token: "A".repeat(64), at: NOW });
      const identity = accountSequenceIdentity(acquired.lease);
      expect((await authority.markSigning({ ...identity, sequence: 7,
        firstLedgerSequence: 100, lastLedgerSequence: 104, at: NOW })).outcome).toBe("transitioned");
      expect((await authority.releasePreSign({ ...identity, at: LATER,
        proof: "signing_never_began" })).outcome).toBe("blocked");
      expect((await authority.markAmbiguous({ ...identity, at: LATER })).outcome).toBe("transitioned");
      expect((await authority.acquire({ principal: "tenant:b", network: "testnet", account: ACCOUNT,
        source: "manual", attemptId: "manual:2", token: "B".repeat(64), at: LATER })).outcome).toBe("blocked");
      expect((await authority.markSigning({ ...identity, token: "D".repeat(64), sequence: 7,
        firstLedgerSequence: 100, lastLedgerSequence: 104, at: LATER })).outcome).toBe("blocked");
    } finally { database.close(); }
  });

  it("releases signed work only on exact validated or complete-absence evidence", async () => {
    const database = new Database();
    try {
      const authority = new AccountSequenceLeaseAuthority(d1(database));
      const acquired = await authority.acquire({ principal: "tenant:a", network: "testnet", account: ACCOUNT,
        source: "manual", attemptId: "manual:1", token: "A".repeat(64), at: NOW });
      const identity = accountSequenceIdentity(acquired.lease);
      await authority.markSigning({ ...identity, sequence: 7, firstLedgerSequence: 100,
        lastLedgerSequence: 104, at: NOW });
      await authority.markAmbiguous({ ...identity, hash: HASH, at: NOW });
      await expect(authority.releaseValidated({ ...identity, hash: HASH,
        ledgerIndex: 105, engineResult: "tesSUCCESS", at: LATER }))
        .rejects.toThrow("outside the leased ledger window");
      await expect(authority.releaseAbsent({ ...identity, hash: HASH, validatedHead: 104,
        checkedFrom: 100, checkedThrough: 104, searchedAll: true, at: LATER } as const))
        .rejects.toThrow("Incomplete absence evidence");
      await expect(authority.releaseAbsent({ ...identity, hash: HASH, validatedHead: 105,
        checkedFrom: 101, checkedThrough: 104, searchedAll: true, at: LATER } as const))
        .rejects.toThrow("Incomplete absence evidence");
      expect((await authority.releaseAbsent({ ...identity, hash: HASH, validatedHead: 105,
        checkedFrom: 100, checkedThrough: 104, searchedAll: true, at: LATER } as const)).outcome).toBe("released");
      const next = await authority.acquire({ principal: "tenant:b", network: "testnet", account: ACCOUNT,
        source: "x402", attemptId: "x402:1", token: "B".repeat(64), at: LATER });
      expect(next.outcome).toBe("acquired");
      expect(next.lease.generation).toBe(2);
    } finally { database.close(); }
  });

  it("transitions signed work to submitted once and reports later claims as replay", async () => {
    const database = new Database();
    try {
      const authority = new AccountSequenceLeaseAuthority(d1(database));
      const acquired = await authority.acquire({ principal: "tenant:a", network: "testnet", account: ACCOUNT,
        source: "manual", attemptId: "manual:once", token: "A".repeat(64), at: NOW });
      const identity = accountSequenceIdentity(acquired.lease);
      await authority.markSigning({ ...identity, sequence: 7, firstLedgerSequence: 100,
        lastLedgerSequence: 104, at: NOW });
      await authority.markSigned({ ...identity, hash: HASH, at: NOW });

      expect((await authority.markSubmitted({ ...identity, hash: HASH, at: LATER })).outcome)
        .toBe("transitioned");
      expect((await authority.markSubmitted({ ...identity, hash: HASH, at: LATER })).outcome)
        .toBe("replay");
      expect(await authority.get({ network: "testnet", account: ACCOUNT })).toMatchObject({
        state: "submitted",
        hash: HASH,
      });
    } finally { database.close(); }
  });
});
