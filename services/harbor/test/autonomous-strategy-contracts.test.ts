import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  StrategyDecisionSchema,
  StrategyMandateSchema,
  StrategySchema,
} from "../src/contracts";

const account = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const issuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const currency = "524C555344000000000000000000000000000000";
const digest = "AB".repeat(32);
const now = "2026-10-22T00:00:00.000Z";
const expiry = "2026-10-23T00:00:00.000Z";

const mandate = {
  mandate_id: "mandate:1",
  strategy_id: "strategy:1",
  version: 1,
  digest,
  status: "approved" as const,
  kind: "xrp_issued_rebalancer_v1" as const,
  network: "testnet" as const,
  account,
  issued_asset: { currency, issuer },
  allocation: {
    target_xrp_bps: 5_000,
    lower_xrp_bps: 4_500,
    upper_xrp_bps: 5_500,
  },
  limits: {
    max_order_value: "25",
    max_daily_value: "100",
    min_order_value: "1",
    max_fee_drops: "20",
    max_slippage_bps: 100,
    max_price_impact_bps: 100,
    min_xrp_reserve_drops: "12000000",
    fee_buffer_drops: "1000",
    max_xrp_exposure_drops: "1000000000",
    max_issued_exposure: "1000",
    min_liquidity_value: "50",
    cooldown_seconds: 300,
    max_quote_age_seconds: 20,
    max_ledger_gap: 1,
  },
  schedule: { interval_seconds: 300, next_evaluation_at: now },
  execution_mode: "offer_create_fok" as const,
  not_before: now,
  expires_at: expiry,
  authorization: {
    authorization_id: "authorization:1",
    method: "wallet_action_proof_v1" as const,
    owner: account,
    mandate_digest: digest,
    mandate_version: 1,
    approved_at: now,
    expires_at: expiry,
  },
};

describe("autonomous strategy contracts", () => {
  it("accepts one exact Testnet pair and an immutable owner authorization", () => {
    expect(StrategyMandateSchema.parse(mandate)).toEqual(mandate);
    expect(
      StrategySchema.parse({
        strategy_id: "strategy:1",
        lifecycle: "active",
        mandate,
        generation: 1,
        next_evaluation_at: now,
        created_at: now,
        updated_at: now,
      }).lifecycle,
    ).toBe("active");
  });

  it("fails closed on mainnet, unapproved activation, bad bands and expanded authorization", () => {
    expect(
      StrategyMandateSchema.safeParse({ ...mandate, network: "mainnet" }).success,
    ).toBe(false);
    expect(
      StrategySchema.safeParse({
        strategy_id: "strategy:1",
        lifecycle: "active",
        mandate: { ...mandate, status: "draft", authorization: undefined },
        generation: 0,
        next_evaluation_at: now,
        created_at: now,
        updated_at: now,
      }).success,
    ).toBe(false);
    expect(
      StrategyMandateSchema.safeParse({
        ...mandate,
        allocation: { ...mandate.allocation, lower_xrp_bps: 5_000 },
      }).success,
    ).toBe(false);
    expect(
      StrategyMandateSchema.safeParse({
        ...mandate,
        authorization: { ...mandate.authorization, mandate_version: 2 },
      }).success,
    ).toBe(false);
    expect(
      StrategyMandateSchema.safeParse({
        ...mandate,
        limits: { ...mandate.limits, max_order_value: "101" },
      }).success,
    ).toBe(false);
  });

  it("requires every deterministic hold to explain itself", () => {
    const base = {
      decision_id: "decision:1",
      trigger_id: "trigger:1",
      strategy_id: "strategy:1",
      mandate_digest: digest,
      mandate_version: 1,
      action: "hold" as const,
      hold_codes: ["inside_band" as const],
      explanation: "XRP allocation remains inside the approved band.",
      created_at: now,
    };
    expect(StrategyDecisionSchema.parse(base)).toEqual(base);
    expect(
      StrategyDecisionSchema.safeParse({ ...base, hold_codes: [] }).success,
    ).toBe(false);
    expect(
      StrategyDecisionSchema.safeParse({
        ...base,
        action: "buy_xrp",
        hold_codes: [],
      }).success,
    ).toBe(false);
  });
});

describe("autonomous strategy migration", () => {
  it("creates fenced, restart-safe, tenant-scoped state with kill enabled", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(
        readFileSync(
          new URL("../migrations/0011_autonomous_strategies.sql", import.meta.url),
          "utf8",
        ),
      );
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => String(row.name));
      expect(tables).toEqual(
        expect.arrayContaining([
          "strategies",
          "strategy_mandates",
          "strategy_schedules",
          "strategy_leases",
          "strategy_triggers",
          "strategy_decisions",
          "strategy_budget_reservations",
          "strategy_executions",
          "strategy_audit_events",
          "strategy_control_receipts",
          "strategy_global_controls",
          "account_sequence_leases",
        ]),
      );

      database
        .prepare(
          "INSERT INTO strategy_global_controls(principal, owner, network, updated_at) VALUES (?, ?, 'testnet', ?)",
        )
        .run("tenant:a", account, now);
      expect(
        database
          .prepare(
            "SELECT kill_enabled, generation FROM strategy_global_controls WHERE principal = ? AND owner = ? AND network = 'testnet'",
          )
          .get("tenant:a", account),
      ).toEqual({ kill_enabled: 1, generation: 0 });

      database.prepare(`INSERT INTO account_sequence_leases(
        principal, network, account, generation, lease_token, source,
        attempt_id, state, sequence, acquired_at, updated_at
      ) VALUES (?, 'testnet', ?, 1, ?, 'strategy', ?, 'signed', 7, ?, ?)`)
        .run("tenant:a", account, "lease:1", "attempt:1", now, now);
      expect(() =>
        database.prepare(`UPDATE account_sequence_leases
          SET state = 'released', released_at = ?
          WHERE principal = ? AND network = 'testnet' AND account = ?`)
          .run(now, "tenant:b", account),
      ).not.toThrow();
      expect(
        database.prepare(`SELECT state FROM account_sequence_leases
          WHERE principal = ? AND network = 'testnet' AND account = ?`)
          .get("tenant:a", account),
      ).toEqual({ state: "signed" });
    } finally {
      database.close();
    }
  });
});
