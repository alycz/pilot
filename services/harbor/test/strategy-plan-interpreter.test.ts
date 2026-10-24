import { describe, expect, it } from "vitest";

import {
  DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
  TESTNET_RLUSD_CURRENCY,
  TESTNET_RLUSD_ISSUER,
  type DeclarativeStrategyProposal,
  type StrategyPlanObservation,
} from "../src/contracts";
import { compileDeclarativeStrategyProposal } from "../src/strategy/plan/compiler";
import { evaluateDeclarativeStrategy } from "../src/strategy/plan/interpreter";

const account = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const now = new Date("2026-10-22T12:00:00.000Z");

function proposal(): DeclarativeStrategyProposal {
  return {
    semantics_version: DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
    kind: "declarative_strategy_v1",
    network: "testnet",
    account,
    issued_asset: {
      currency: TESTNET_RLUSD_CURRENCY,
      issuer: TESTNET_RLUSD_ISSUER,
    },
    plan: {
      plan_version: "1",
      trigger: { kind: "interval", interval_seconds: 300 },
      rules: [
        {
          rule_id: "buy-under-one",
          all: [
            {
              kind: "price_threshold",
              side: "ask",
              comparator: "lte",
              price: "1",
            },
          ],
          action: {
            kind: "fixed_swap",
            direction: "buy_xrp",
            order_value: "5",
          },
        },
      ],
      fallback: { kind: "hold" },
    },
    limits: {
      max_order_value: "10",
      max_daily_value: "50",
      max_cumulative_value: "500",
      min_order_value: "1",
      max_fee_drops: "20",
      max_daily_fee_drops: "100",
      max_cumulative_fee_drops: "1000",
      max_daily_trades: 10,
      max_total_trades: 100,
      cumulative_scope: "owner_network_asset_lifetime",
      max_slippage_bps: 100,
      max_price_impact_bps: 200,
      min_xrp_reserve_drops: "12000000",
      fee_buffer_drops: "1000",
      max_xrp_exposure_drops: "1000000000",
      max_issued_exposure: "1000",
      min_liquidity_value: "10",
      cooldown_seconds: 300,
      max_quote_age_seconds: 20,
      max_ledger_gap: 1,
    },
    execution_mode: "offer_create_fok",
    not_before: "2026-10-22T00:00:00.000Z",
    expires_at: "2026-10-23T00:00:00.000Z",
  };
}

function observation(
  overrides: Partial<StrategyPlanObservation> = {},
): StrategyPlanObservation {
  return {
    account,
    network: "testnet",
    issued_asset: {
      currency: TESTNET_RLUSD_CURRENCY,
      issuer: TESTNET_RLUSD_ISSUER,
    },
    xrp_balance_drops: "50000000",
    issued_balance: "50",
    bid: "0.99",
    ask: "1",
    executable_liquidity_value: "500",
    fee_drops: "12",
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
    observed_at: now.toISOString(),
    global_kill: false,
    unresolved_execution: false,
    grant_active: true,
    policy_active: true,
    ...overrides,
  };
}

function evaluate(overrides: Partial<StrategyPlanObservation> = {}) {
  return evaluateDeclarativeStrategy({
    authority: proposal(),
    observation: observation(overrides),
    triggerId: "trigger:preview",
    decisionId: "decision:preview",
    now,
  });
}

describe("declarative strategy interpreter", () => {
  it("uses first-match semantics and executable ask for a fixed buy", async () => {
    const evaluated = await evaluate();
    expect(evaluated.preview).toMatchObject({
      boundary: "paper_only",
      ledger_acceptance: "not_tested",
      outcome: "order",
      action: "buy_xrp",
      matched_rule_id: "buy-under-one",
      proposed_value: "5",
      price_basis: "ask",
      price_value: "1",
    });
    expect(evaluated.decision.semantics_version).toBe(
      DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
    );
    expect(evaluated.decision.plan_digest).toMatch(/^[A-F0-9]{64}$/);
  });

  it("accepts an approved mandate whose digest is the compiled authority digest", async () => {
    const compiled = await compileDeclarativeStrategyProposal(proposal());
    const evaluated = await evaluateDeclarativeStrategy({
      authority: {
        ...compiled.proposal,
        mandate_id: "mandate:declarative-1",
        strategy_id: "strategy:declarative-1",
        version: 1,
        digest: compiled.planDigest,
        status: "approved",
        schedule: {
          interval_seconds: compiled.proposal.plan.trigger.interval_seconds,
          next_evaluation_at: now.toISOString(),
        },
        authorization: {
          authorization_id: "authorization:declarative-1",
          method: "wallet_action_proof_v1",
          owner: account,
          mandate_digest: compiled.planDigest,
          mandate_version: 1,
          approved_at: "2026-10-22T00:00:00.000Z",
          expires_at: "2026-10-23T00:00:00.000Z",
        },
      },
      observation: observation(),
      triggerId: "trigger:mandate",
      decisionId: "decision:mandate",
      now,
    });
    expect(evaluated.decision.strategy_id).toBe("strategy:declarative-1");
    expect(evaluated.decision.mandate_digest).toBe(compiled.planDigest);
    expect(evaluated.preview.outcome).toBe("order");
  });

  it("holds deterministically when no rule matches without inventing a signal", async () => {
    const evaluated = await evaluate({ ask: "1.01" });
    expect(evaluated.preview.outcome).toBe("hold");
    expect(evaluated.preview.hold_codes).toEqual(["no_rule_matched"]);
  });

  it("fails closed for stale provenance, lifetime value, fees, counts, kill, and unresolved state", async () => {
    const cases: Array<
      [Partial<StrategyPlanObservation>, string]
    > = [
      [{ observed_at: "2026-10-22T11:59:00.000Z" }, "stale_price"],
      [{ cumulative_value_used: "500" }, "cumulative_limit"],
      [{ cumulative_fee_drops_used: "1000" }, "fee_budget_limit"],
      [{ total_trades_used: 100 }, "trade_count_limit"],
      [{ global_kill: true }, "global_kill"],
      [{ unresolved_execution: true }, "pending_reconciliation"],
    ];
    for (const [overrides, code] of cases) {
      expect((await evaluate(overrides)).preview.hold_codes).toContain(code);
    }
  });

  it("enforces the approval-bound executable spread limit", async () => {
    const evaluated = await evaluate({ bid: "0.9", ask: "1" });
    expect(evaluated.preview.hold_codes).toEqual(["insufficient_liquidity"]);
    expect(evaluated.preview.explanation).toContain("spread");
  });

  it("is deterministic and does not mutate observations or proposals", async () => {
    const authority = proposal();
    const observed = observation();
    const before = JSON.stringify({ authority, observed });
    const input = {
      authority,
      observation: observed,
      triggerId: "trigger:same",
      decisionId: "decision:same",
      now,
    };
    expect(await evaluateDeclarativeStrategy(input)).toEqual(
      await evaluateDeclarativeStrategy(input),
    );
    expect(JSON.stringify({ authority, observed })).toBe(before);
  });
});
