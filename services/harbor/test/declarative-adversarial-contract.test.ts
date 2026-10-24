import { describe, expect, it } from "vitest";

import {
  DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
  TESTNET_RLUSD_CURRENCY,
  TESTNET_RLUSD_ISSUER,
} from "../src/contracts";
import {
  strategyProposalDigest,
  validateDeclarativeStrategyProposal,
} from "../src/strategy/plan/compiler";

const ACCOUNT = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

function limits() {
  return {
    max_order_value: "25",
    max_daily_value: "100",
    max_cumulative_value: "500",
    min_order_value: "1",
    max_fee_drops: "20",
    max_daily_fee_drops: "80",
    max_cumulative_fee_drops: "2000",
    max_daily_trades: 4,
    max_total_trades: 100,
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
    cumulative_scope: "owner_network_asset_lifetime" as const,
  };
}

function proposal() {
  return {
    semantics_version: DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
    kind: "declarative_strategy_v1" as const,
    network: "testnet" as const,
    account: ACCOUNT,
    issued_asset: {
      currency: TESTNET_RLUSD_CURRENCY,
      issuer: TESTNET_RLUSD_ISSUER,
    },
    plan: {
      plan_version: "1" as const,
      trigger: { kind: "interval" as const, interval_seconds: 300 },
      rules: [
        {
          rule_id: "buy-low",
          all: [{ kind: "price_threshold" as const, side: "ask" as const, comparator: "lte" as const, price: "0.95" }],
          action: { kind: "fixed_swap" as const, direction: "buy_xrp" as const, order_value: "10" },
        },
        {
          rule_id: "dca",
          all: [{ kind: "always" as const }],
          action: { kind: "fixed_swap" as const, direction: "buy_xrp" as const, order_value: "5" },
        },
      ],
      fallback: { kind: "hold" as const },
    },
    limits: limits(),
    execution_mode: "offer_create_fok" as const,
    not_before: "2026-10-23T00:00:00.000Z",
    expires_at: "2026-10-30T00:00:00.000Z",
  };
}

describe("declarative strategy hostile proposal boundaries", () => {
  it.each([
    ["mainnet", (value: any) => { value.network = "mainnet"; }],
    ["wrong issuer", (value: any) => { value.issued_asset.issuer = ACCOUNT; }],
    ["script action", (value: any) => { value.plan.rules[0].action = { kind: "script", code: "return sign(seed)" }; }],
    ["URL field", (value: any) => { value.plan.rules[0].action.url = "https://attacker.invalid"; }],
    ["recursive condition", (value: any) => { value.plan.rules[0].all = [{ kind: "all", conditions: [{ kind: "always" }] }]; }],
    ["model authority", (value: any) => { value.authorization = { approved: true, source: "model" }; }],
  ])("rejects %s without compiling authority", async (_name, mutate) => {
    const input: any = structuredClone(proposal());
    mutate(input);
    const result = await validateDeclarativeStrategyProposal(input);
    expect(result.valid).toBe(false);
    expect(result.plan_digest).toBeUndefined();
    expect(result.normalized_proposal).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects rule/condition size excess and unsafe atomic numeric ranges", async () => {
    const tooManyRules: any = structuredClone(proposal());
    tooManyRules.plan.rules = Array.from({ length: 9 }, (_, index) => ({
      rule_id: `rule-${index}`,
      all: [{ kind: "always" }],
      action: { kind: "fixed_swap", direction: "buy_xrp", order_value: "1" },
    }));
    expect((await validateDeclarativeStrategyProposal(tooManyRules)).valid).toBe(false);

    const tooManyConditions: any = structuredClone(proposal());
    tooManyConditions.plan.rules = [{
      rule_id: "oversized",
      all: Array.from({ length: 9 }, (_, index) => ({
        kind: "price_threshold", side: "ask", comparator: index % 2 ? "gte" : "lte", price: String(index + 1),
      })),
      action: { kind: "fixed_swap", direction: "buy_xrp", order_value: "1" },
    }];
    expect((await validateDeclarativeStrategyProposal(tooManyConditions)).valid).toBe(false);

    const overflow: any = structuredClone(proposal());
    overflow.limits.max_cumulative_value = "9000000000.000001";
    const overflowResult = await validateDeclarativeStrategyProposal(overflow);
    expect(overflowResult.valid).toBe(false);
    expect(overflowResult.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "numeric_overflow", path: "limits.max_cumulative_value" }),
    ]));
  });

  it("rejects fee budgets that cannot be persisted in atomic quota storage", async () => {
    const input: any = structuredClone(proposal());
    input.limits.max_fee_drops = "9000000000000001";
    input.limits.max_daily_fee_drops = "9000000000000001";
    input.limits.max_cumulative_fee_drops = "9000000000000001";

    const result = await validateDeclarativeStrategyProposal(input);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "numeric_overflow", path: "limits.max_fee_drops" }),
      expect.objectContaining({ code: "numeric_overflow", path: "limits.max_daily_fee_drops" }),
      expect.objectContaining({ code: "numeric_overflow", path: "limits.max_cumulative_fee_drops" }),
    ]));
  });

  it("rejects contradictory finite recurring occurrence limits", async () => {
    const belowDaily: any = structuredClone(proposal());
    belowDaily.limits.max_mandate_occurrences = 3;
    const belowDailyResult = await validateDeclarativeStrategyProposal(belowDaily);
    expect(belowDailyResult.valid).toBe(false);
    expect(belowDailyResult.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "limits.max_daily_trades",
        message: "daily trade count cannot exceed mandate occurrences",
      }),
    ]));

    const aboveLifetime: any = structuredClone(proposal());
    aboveLifetime.limits.max_mandate_occurrences = 101;
    const aboveLifetimeResult = await validateDeclarativeStrategyProposal(aboveLifetime);
    expect(aboveLifetimeResult.valid).toBe(false);
    expect(aboveLifetimeResult.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "limits.max_mandate_occurrences",
        message: "mandate occurrences cannot exceed total trade count",
      }),
    ]));
  });

  it("requires threshold conditions to use the eventual executable book side", async () => {
    const buyOnBid: any = structuredClone(proposal());
    buyOnBid.plan.rules = [{
      rule_id: "wrong-buy-side",
      all: [{ kind: "price_threshold", side: "bid", comparator: "lte", price: "1" }],
      action: { kind: "fixed_swap", direction: "buy_xrp", order_value: "10" },
    }];
    expect((await validateDeclarativeStrategyProposal(buyOnBid)).errors)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "ambiguous_conditions" })]));

    const sellOnAsk: any = structuredClone(proposal());
    sellOnAsk.plan.rules = [{
      rule_id: "wrong-sell-side",
      all: [{ kind: "price_threshold", side: "ask", comparator: "gte", price: "1" }],
      action: { kind: "fixed_swap", direction: "sell_xrp", order_value: "10" },
    }];
    expect((await validateDeclarativeStrategyProposal(sellOnAsk)).valid).toBe(false);
  });

  it("binds ordered semantics and every risk-bearing field while ignoring object key insertion order", async () => {
    const valid = await validateDeclarativeStrategyProposal(proposal());
    expect(valid.valid).toBe(true);
    const normalized = valid.normalized_proposal!;
    const reordered = {
      expires_at: normalized.expires_at,
      not_before: normalized.not_before,
      execution_mode: normalized.execution_mode,
      limits: Object.fromEntries(Object.entries(normalized.limits).reverse()),
      plan: normalized.plan,
      issued_asset: normalized.issued_asset,
      account: normalized.account,
      network: normalized.network,
      kind: normalized.kind,
      semantics_version: normalized.semantics_version,
    } as typeof normalized;
    expect(await strategyProposalDigest(reordered)).toBe(valid.plan_digest);

    const reversedRules = structuredClone(normalized);
    reversedRules.plan.rules.reverse();
    expect(await strategyProposalDigest(reversedRules)).not.toBe(valid.plan_digest);

    const expandedLimit = structuredClone(normalized);
    expandedLimit.limits.max_cumulative_value = "501";
    expect(await strategyProposalDigest(expandedLimit)).not.toBe(valid.plan_digest);

    const finiteRecurring = structuredClone(normalized);
    finiteRecurring.limits.max_mandate_occurrences = 4;
    const finiteRecurringResult = await validateDeclarativeStrategyProposal(
      finiteRecurring,
    );
    expect(finiteRecurringResult.valid).toBe(true);
    expect(finiteRecurringResult.plan_digest).not.toBe(valid.plan_digest);
  });
});
