import { describe, expect, it } from "vitest";

import {
  compileDeclarativePlan,
  defaultDeclarativePlan,
  newDeclarativeRule,
  previewDeclarativePlan,
  validateDeclarativePlan,
} from "./declarative-model";

describe("declarative strategy editor model", () => {
  it("compiles only the reviewed flat first-match grammar", () => {
    const plan = defaultDeclarativePlan();
    plan.rules = [
      { ...newDeclarativeRule(0), id: "dca", kind: "scheduled_buy", fixedValue: "12.5" },
      { ...newDeclarativeRule(1), id: "buy-low", kind: "price_buy", price: "0.95", fixedValue: "20" },
      { ...newDeclarativeRule(2), id: "sell-high", kind: "price_sell", price: "1.25", fixedValue: "15" },
    ];
    expect(validateDeclarativePlan(plan)).toEqual([]);
    expect(compileDeclarativePlan(plan)).toEqual({
      plan_version: "1",
      trigger: { kind: "interval", interval_seconds: 300 },
      rules: [
        { rule_id: "dca", all: [{ kind: "always" }], action: { kind: "fixed_swap", direction: "buy_xrp", order_value: "12.5" } },
        { rule_id: "buy-low", all: [{ kind: "price_threshold", side: "ask", comparator: "lte", price: "0.95" }], action: { kind: "fixed_swap", direction: "buy_xrp", order_value: "20" } },
        { rule_id: "sell-high", all: [{ kind: "price_threshold", side: "bid", comparator: "gte", price: "1.25" }], action: { kind: "fixed_swap", direction: "sell_xrp", order_value: "15" } },
      ],
      fallback: { kind: "hold" },
    });
  });

  it("rejects oversized, duplicate, malformed and overflow-like plans", () => {
    const plan = defaultDeclarativePlan();
    plan.intervalSeconds = "299";
    plan.maxDailyTrades = "999999999999999999999999";
    plan.rules = Array.from({ length: 9 }, (_, index) => ({ ...newDeclarativeRule(index), id: "duplicate", fixedValue: "1e100" }));
    const codes = validateDeclarativePlan(plan).map((diagnostic) => diagnostic.code);
    expect(codes).toContain("unsupported_interval");
    expect(codes).toContain("invalid_trade_count");
    expect(codes).toContain("plan_too_large");
    expect(codes).toContain("duplicate_rule_id");
    expect(codes).toContain("invalid_fixed_value");
  });

  it("enforces daily trades <= immutable mandate actions <= lifetime total trades", () => {
    const belowDaily = defaultDeclarativePlan();
    belowDaily.maxDailyTrades = "5";
    belowDaily.maxMandateOccurrences = "4";
    expect(validateDeclarativePlan(belowDaily)).toContainEqual(expect.objectContaining({
      code: "mandate_occurrences_below_daily_trades",
      path: "limits.max_mandate_occurrences",
    }));

    const aboveLifetime = defaultDeclarativePlan();
    aboveLifetime.maxMandateOccurrences = "101";
    aboveLifetime.maxTotalTrades = "100";
    expect(validateDeclarativePlan(aboveLifetime)).toContainEqual(expect.objectContaining({
      code: "mandate_occurrences_above_lifetime_trades",
      path: "limits.max_mandate_occurrences",
    }));
  });

  it("rejects model-injected fields and unsupported executable actions", () => {
    const plan = defaultDeclarativePlan() as unknown as Record<string, unknown>;
    plan.script = "fetch('https://attacker.example')";
    plan.rules = [{ ...newDeclarativeRule(0), kind: "arbitrary_code", url: "https://attacker.example" }];
    const diagnostics = validateDeclarativePlan(plan as never);
    expect(diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(["unsupported_field", "unsupported_rule"]));
    expect(diagnostics.map((item) => item.path)).toEqual(expect.arrayContaining(["plan.script", "plan.rules.0.url", "plan.rules.0.kind"]));
  });

  it("previews first-match semantics only from explicit paper inputs", () => {
    const plan = defaultDeclarativePlan();
    plan.rules = [
      { ...newDeclarativeRule(0), id: "buy-low", kind: "price_buy", price: "0.95", fixedValue: "20" },
      { ...newDeclarativeRule(1), id: "rebalance", kind: "rebalance", lowerXrpBps: "4500", targetXrpBps: "5000", upperXrpBps: "5500" },
    ];
    expect(previewDeclarativePlan(plan, { observedAt: "", executableBid: "", executableAsk: "", xrpAllocationBps: "" }).status).toBe("not_ready");
    const preview = previewDeclarativePlan(plan, { observedAt: "2026-10-23T12:00", executableBid: "0.89", executableAsk: "0.90", xrpAllocationBps: "4000" });
    expect(preview).toMatchObject({ status: "planned", matchedRuleId: "buy-low" });
    expect(preview.explanation).toContain("first matching rule");
  });

  it("uses exact fixed-point bid and ask comparisons", () => {
    const plan = defaultDeclarativePlan();
    plan.rules = [{ ...newDeclarativeRule(0), id: "precise-buy", kind: "price_buy", price: "8000000000.000001", fixedValue: "1" }];
    const preview = previewDeclarativePlan(plan, { observedAt: "2026-10-23T12:00", executableBid: "8000000000", executableAsk: "8000000000.000002", xrpAllocationBps: "5000" });
    expect(preview.status).toBe("hold");
  });
});
