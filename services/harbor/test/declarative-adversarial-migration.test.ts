import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

const ACCOUNT = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const NOW = "2026-10-23T00:00:00.000Z";

function migration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

function schema(database: DatabaseSync): Array<{ name: string; sql: string }> {
  return database
    .prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL ORDER BY name")
    .all()
    .map((row) => ({ name: String(row.name), sql: String(row.sql) }));
}

describe("declarative strategy additive migration boundaries", () => {
  it("appends after the merged demo-quota 0013 migration", () => {
    const names = readdirSync(new URL("../migrations/", import.meta.url))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(names).toContain("0013_demo_model_quota.sql");
    expect(names).toContain("0014_declarative_strategies.sql");
    expect(names.filter((name) => name.startsWith("0014_"))).toEqual([
      "0014_declarative_strategies.sql",
    ]);
    expect(names.indexOf("0014_declarative_strategies.sql")).toBeGreaterThan(
      names.indexOf("0013_demo_model_quota.sql"),
    );
  });

  it("adds only new declarative objects and leaves every legacy schema byte unchanged", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(migration("0011_autonomous_strategies.sql"));
      const before = schema(database);
      database.exec(migration("0012_isolated_sequence_authority.sql"));
      database.exec(migration("0014_declarative_strategies.sql"));
      const after = new Map(schema(database).map((entry) => [entry.name, entry.sql]));

      for (const entry of before) expect(after.get(entry.name)).toBe(entry.sql);
      expect(after.has("strategy_declarative_plans")).toBe(true);
      expect(after.has("strategy_declarative_reservations")).toBe(true);
    } finally {
      database.close();
    }
  });

  it("rejects unreviewed versions, non-uppercase digests, unsafe accounting and duplicate decisions", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(migration("0011_autonomous_strategies.sql"));
      database.exec(migration("0014_declarative_strategies.sql"));
      const insertPlan = database.prepare(`INSERT INTO strategy_declarative_plans(
        mandate_id, principal, strategy_id, mandate_version, plan_version,
        plan_digest, plan_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

      expect(() => insertPlan.run(
        "mandate:bad-version", "tenant:a", "strategy:a", 1,
        "2", "A".repeat(64), "{}", NOW,
      )).toThrow();
      expect(() => insertPlan.run(
        "mandate:lower-digest", "tenant:a", "strategy:a", 1,
        "1", "a".repeat(64), "{}", NOW,
      )).toThrow();

      insertPlan.run(
        "mandate:a", "tenant:a", "strategy:a", 1,
        "1", "A".repeat(64), "{}", NOW,
      );
      expect(() => insertPlan.run(
        "mandate:a-duplicate-version", "tenant:a", "strategy:a", 1,
        "1", "B".repeat(64), "{}", NOW,
      )).toThrow();

      // The same digest in another tenant is not a cross-tenant uniqueness oracle.
      expect(() => insertPlan.run(
        "mandate:b", "tenant:b", "strategy:b", 1,
        "1", "A".repeat(64), "{}", NOW,
      )).not.toThrow();

      const insertReservation = database.prepare(`INSERT INTO strategy_declarative_reservations(
        id, principal, strategy_id, decision_id, mandate_id, mandate_version,
        owner, network, issued_currency, issued_issuer, authority_not_before,
        authority_expires_at, order_value, order_value_microunits, fee_drops,
        state, execution_id, reserved_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const values = [
        "reservation:a", "tenant:a", "strategy:a", "decision:a", "mandate:a", 1,
        ACCOUNT, "testnet", "524C555344000000000000000000000000000000",
        "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV", NOW, "2026-10-30T00:00:00.000Z",
        "1", 1_000_000, 12, "reserved", "execution:a", NOW, NOW,
      ] as const;
      insertReservation.run(...values);
      expect(() => insertReservation.run(
        "reservation:duplicate", "tenant:a", "strategy:a", "decision:a", "mandate:a", 1,
        ACCOUNT, "testnet", "524C555344000000000000000000000000000000",
        "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV", NOW, "2026-10-30T00:00:00.000Z",
        "1", 1_000_000, 12, "reserved", "execution:duplicate", NOW, NOW,
      )).toThrow();
      expect(() => insertReservation.run(
        "reservation:overflow", "tenant:a", "strategy:a", "decision:overflow", "mandate:a", 1,
        ACCOUNT, "testnet", "524C555344000000000000000000000000000000",
        "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV", NOW, "2026-10-30T00:00:00.000Z",
        "9000000000", 9_000_000_000_000_001, 12, "reserved", "execution:overflow", NOW, NOW,
      )).toThrow();
      expect(() => insertReservation.run(
        "reservation:negative-fee", "tenant:a", "strategy:a", "decision:fee", "mandate:a", 1,
        ACCOUNT, "testnet", "524C555344000000000000000000000000000000",
        "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV", NOW, "2026-10-30T00:00:00.000Z",
        "1", 1_000_000, -1, "reserved", "execution:fee", NOW, NOW,
      )).toThrow();
      expect(() => insertReservation.run(
        "reservation:unknown-state", "tenant:a", "strategy:a", "decision:state", "mandate:a", 1,
        ACCOUNT, "testnet", "524C555344000000000000000000000000000000",
        "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV", NOW, "2026-10-30T00:00:00.000Z",
        "1", 1_000_000, 12, "pending", "execution:state", NOW, NOW,
      )).toThrow();
    } finally {
      database.close();
    }
  });

  it("keeps the isolated-profile migration byte-identical to the canonical additive migration", () => {
    expect(readFileSync(new URL(
      "../migrations-profile-trading-isolated-v1/0014_declarative_strategies.sql",
      import.meta.url,
    ), "utf8")).toBe(migration("0014_declarative_strategies.sql"));
  });
});
