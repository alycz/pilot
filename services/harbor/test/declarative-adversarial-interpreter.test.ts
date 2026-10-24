import { describe, expect, it } from "vitest";

import {
  DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
  TESTNET_RLUSD_CURRENCY,
  TESTNET_RLUSD_ISSUER,
  type DeclarativeStrategyMandate,
  type DeclarativeStrategyProposal,
  type StrategyPlanObservation,
} from "../src/contracts";
import { compileDeclarativeStrategyProposal } from "../src/strategy/plan/compiler";
import { evaluateDeclarativeStrategy } from "../src/strategy/plan/interpreter";

const ACCOUNT = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const NOW = new Date("2026-10-23T12:00:00.000Z");

function proposal(): DeclarativeStrategyProposal {
  return {
    semantics_version: DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
    kind: "declarative_strategy_v1",
    network: "testnet",
    account: ACCOUNT,
    issued_asset: { currency: TESTNET_RLUSD_CURRENCY, issuer: TESTNET_RLUSD_ISSUER },
    plan: {
      plan_version: "1",
      trigger: { kind: "interval", interval_seconds: 300 },
      rules: [{
        rule_id: "first-buy",
        all: [{ kind: "price_threshold", side: "ask", comparator: "lte", price: "1" }],
        action: { kind: "fixed_swap", direction: "buy_xrp", order_value: "5" },
      }, {
        rule_id: "second-buy",
        all: [{ kind: "price_threshold", side: "ask", comparator: "lte", price: "1.1" }],
        action: { kind: "fixed_swap", direction: "buy_xrp", order_value: "6" },
      }],
      fallback: { kind: "hold" },
    },
    limits: {
      max_order_value: "10", max_daily_value: "50", max_cumulative_value: "500", min_order_value: "1",
      max_fee_drops: "20", max_daily_fee_drops: "100", max_cumulative_fee_drops: "1000",
      max_daily_trades: 10, max_total_trades: 100, cumulative_scope: "owner_network_asset_lifetime",
      max_slippage_bps: 100, max_price_impact_bps: 100,
      min_xrp_reserve_drops: "12000000", fee_buffer_drops: "1000",
      max_xrp_exposure_drops: "1000000000", max_issued_exposure: "1000",
      min_liquidity_value: "10", cooldown_seconds: 300, max_quote_age_seconds: 20, max_ledger_gap: 1,
    },
    execution_mode: "offer_create_fok",
    not_before: "2026-10-23T00:00:00.000Z",
    expires_at: "2026-10-30T00:00:00.000Z",
  };
}

function observation(overrides: Partial<StrategyPlanObservation> = {}): StrategyPlanObservation {
  return {
    account: ACCOUNT,
    network: "testnet",
    issued_asset: { currency: TESTNET_RLUSD_CURRENCY, issuer: TESTNET_RLUSD_ISSUER },
    xrp_balance_drops: "50000000", issued_balance: "50", bid: "0.995", ask: "1",
    executable_liquidity_value: "500", fee_drops: "12",
    reserve_base_drops: "10000000", reserve_increment_drops: "2000000", owner_count: 1,
    daily_value_used: "0", cumulative_value_used: "0",
    daily_fee_drops_used: "0", cumulative_fee_drops_used: "0",
    daily_trades_used: 0, total_trades_used: 0,
    ledger_index: 100, quote_ledger_index: 100, observed_at: NOW.toISOString(),
    global_kill: false, unresolved_execution: false, grant_active: true, policy_active: true,
    ...overrides,
  };
}

async function evaluate(
  authority: DeclarativeStrategyProposal | DeclarativeStrategyMandate = proposal(),
  overrides: Partial<StrategyPlanObservation> = {},
) {
  return evaluateDeclarativeStrategy({
    authority,
    observation: observation(overrides),
    triggerId: "trigger:adversarial",
    decisionId: "decision:adversarial",
    now: NOW,
  });
}

describe("declarative strategy adversarial interpreter", () => {
  it("uses exact threshold equality, first-match order and executable ask pricing", async () => {
    const exact = await evaluate();
    expect(exact.preview).toMatchObject({
      outcome: "order", matched_rule_id: "first-buy", proposed_value: "5",
      price_basis: "ask", price_value: "1",
    });
    expect((await evaluate(proposal(), { ask: "1.000000000000001" })).preview)
      .toMatchObject({ outcome: "order", matched_rule_id: "second-buy", proposed_value: "6" });
  });

  it.each([
    ["future quote", { observed_at: "2026-10-23T12:00:00.001Z" }, "stale_price"],
    ["stale quote", { observed_at: "2026-10-23T11:59:39.999Z" }, "stale_price"],
    ["future ledger", { quote_ledger_index: 101 }, "contradictory_price"],
    ["ledger gap", { ledger_index: 102, quote_ledger_index: 100 }, "contradictory_price"],
    ["crossed book", { bid: "1.01", ask: "1" }, "contradictory_price"],
    ["wrong account", { account: "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn" }, "contradictory_price"],
    ["revoked grant", { grant_active: false }, "grant_not_active"],
    ["policy pause", { policy_active: false }, "policy_paused"],
    ["kill race", { global_kill: true }, "global_kill"],
    ["unknown prior submit", { unresolved_execution: true }, "pending_reconciliation"],
  ] as const)("holds for %s", async (_label, overrides, code) => {
    expect((await evaluate(proposal(), overrides)).preview.hold_codes).toContain(code);
  });

  it("uses fixed-point lifetime accounting at the exact cap boundary", async () => {
    expect((await evaluate(proposal(), {
      daily_value_used: "45", cumulative_value_used: "495",
    })).preview.outcome).toBe("order");
    expect((await evaluate(proposal(), {
      daily_value_used: "45.000000000000001", cumulative_value_used: "495",
    })).preview.hold_codes).toContain("daily_limit");
    expect((await evaluate(proposal(), {
      daily_value_used: "0", cumulative_value_used: "495.000000000000001",
    })).preview.hold_codes).toContain("cumulative_limit");
  });

  it("rejects wide executable spreads under the approval-bound impact cap", async () => {
    expect((await evaluate(proposal(), { bid: "0.9", ask: "1" })).preview.hold_codes)
      .toContain("insufficient_liquidity");
  });

  it("fails closed when an approved mandate digest does not bind the compiled plan", async () => {
    const compiled = await compileDeclarativeStrategyProposal(proposal());
    const mandate: DeclarativeStrategyMandate = {
      ...compiled.proposal,
      mandate_id: "mandate:adversarial",
      strategy_id: "strategy:adversarial",
      version: 2,
      digest: "A".repeat(64),
      status: "approved",
      schedule: { interval_seconds: 300, next_evaluation_at: NOW.toISOString() },
      authorization: {
        authorization_id: "authorization:adversarial",
        method: "wallet_action_proof_v1",
        owner: ACCOUNT,
        mandate_digest: "A".repeat(64),
        mandate_version: 2,
        approved_at: "2026-10-23T00:00:00.000Z",
        expires_at: "2026-10-30T00:00:00.000Z",
      },
    };
    expect((await evaluate(mandate)).preview.hold_codes).toContain("mandate_not_current");
  });

  it("never presents paper evaluation as ledger acceptance or profitability", async () => {
    const serialized = JSON.stringify((await evaluate()).preview);
    expect(serialized).toContain('"boundary":"paper_only"');
    expect(serialized).toContain('"ledger_acceptance":"not_tested"');
    expect(serialized).not.toMatch(/profit|return|yield|validated|executed/i);
  });
});
