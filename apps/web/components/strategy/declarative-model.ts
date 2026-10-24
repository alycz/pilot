export const MAX_DECLARATIVE_RULES = 8;

export type DeclarativeRuleKind = "scheduled_buy" | "price_buy" | "price_sell" | "rebalance";

export type DeclarativeRuleDraft = {
  id: string;
  kind: DeclarativeRuleKind;
  price: string;
  fixedValue: string;
  lowerXrpBps: string;
  targetXrpBps: string;
  upperXrpBps: string;
};

export type DeclarativePlanDraft = {
  intervalSeconds: string;
  rules: DeclarativeRuleDraft[];
  maxDailyTrades: string;
  maxTotalTrades: string;
  maxMandateOccurrences: string;
  maxCumulativeValue: string;
  maxDailyFeeDrops: string;
  maxCumulativeFeeDrops: string;
};

export type PlanDiagnostic = {
  code: string;
  path: string;
  message: string;
};

export type PaperInputs = {
  observedAt: string;
  executableBid: string;
  executableAsk: string;
  xrpAllocationBps: string;
};

export type PaperPreview = {
  status: "not_ready" | "hold" | "planned";
  matchedRuleId?: string;
  explanation: string;
  action?: string;
};

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,15})?$/;
const INTEGER = /^(?:0|[1-9]\d*)$/;

function decimalInteger(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000_000_000_000n + BigInt(fraction.padEnd(15, "0"));
}

function positiveDecimal(value: string): boolean {
  return typeof value === "string" && value.length <= 64 && DECIMAL.test(value) && decimalInteger(value) > 0n && decimalInteger(value) <= 9_000_000_000n * 1_000_000_000_000_000n;
}

function compareDecimal(left: string, right: string): number {
  const a = decimalInteger(left);
  const b = decimalInteger(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function integerIn(value: string, minimum: number, maximum: number): boolean {
  return typeof value === "string" && INTEGER.test(value) && BigInt(value) >= BigInt(minimum) && BigInt(value) <= BigInt(maximum);
}

export function defaultDeclarativePlan(): DeclarativePlanDraft {
  return {
    intervalSeconds: "300",
    maxDailyTrades: "4",
    maxTotalTrades: "100",
    maxMandateOccurrences: "12",
    maxCumulativeValue: "500",
    maxDailyFeeDrops: "80",
    maxCumulativeFeeDrops: "2000",
    rules: [{
      id: "rule-1",
      kind: "rebalance",
      price: "1",
      fixedValue: "10",
      lowerXrpBps: "4500",
      targetXrpBps: "5000",
      upperXrpBps: "5500",
    }],
  };
}

export function newDeclarativeRule(index: number): DeclarativeRuleDraft {
  return {
    id: `rule-${index + 1}`,
    kind: "scheduled_buy",
    price: "1",
    fixedValue: "10",
    lowerXrpBps: "4500",
    targetXrpBps: "5000",
    upperXrpBps: "5500",
  };
}

export function describeRule(rule: DeclarativeRuleDraft): string {
  if (rule.kind === "scheduled_buy") return `Every evaluation, buy ${rule.fixedValue} RLUSD of XRP.`;
  if (rule.kind === "price_buy") return `When executable ask is at or below ${rule.price} RLUSD/XRP, buy ${rule.fixedValue} RLUSD of XRP.`;
  if (rule.kind === "price_sell") return `When executable bid is at or above ${rule.price} RLUSD/XRP, sell ${rule.fixedValue} RLUSD of XRP.`;
  return `When XRP allocation leaves ${Number(rule.lowerXrpBps) / 100}–${Number(rule.upperXrpBps) / 100}%, rebalance toward ${Number(rule.targetXrpBps) / 100}%.`;
}

export function validateDeclarativePlan(plan: DeclarativePlanDraft): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return [{ code: "malformed_plan", path: "plan", message: "Plan must be a structured object." }];
  const allowedPlanKeys = new Set(["intervalSeconds", "rules", "maxDailyTrades", "maxTotalTrades", "maxMandateOccurrences", "maxCumulativeValue", "maxDailyFeeDrops", "maxCumulativeFeeDrops"]);
  for (const key of Object.keys(plan)) if (!allowedPlanKeys.has(key)) diagnostics.push({ code: "unsupported_field", path: `plan.${key}`, message: "This field is not part of the reviewed strategy grammar." });
  if (!integerIn(plan.intervalSeconds, 300, 86_400)) diagnostics.push({ code: "unsupported_interval", path: "plan.trigger.interval_seconds", message: "Evaluation interval must be from 300 to 86,400 seconds." });
  if (!integerIn(plan.maxDailyTrades, 1, 100)) diagnostics.push({ code: "invalid_trade_count", path: "limits.max_daily_trades", message: "Daily trade count must be from 1 to 100." });
  if (!integerIn(plan.maxTotalTrades, 1, 10_000)) diagnostics.push({ code: "invalid_total_trade_count", path: "limits.max_total_trades", message: "Total trade count must be from 1 to 10,000." });
  if (!integerIn(plan.maxMandateOccurrences, 1, 100_000)) diagnostics.push({ code: "invalid_mandate_occurrences", path: "limits.max_mandate_occurrences", message: "Executed-action count for this immutable mandate must be from 1 to 100,000." });
  if (integerIn(plan.maxDailyTrades, 1, 100) && integerIn(plan.maxMandateOccurrences, 1, 100_000) && BigInt(plan.maxDailyTrades) > BigInt(plan.maxMandateOccurrences)) {
    diagnostics.push({ code: "mandate_occurrences_below_daily_trades", path: "limits.max_mandate_occurrences", message: "Immutable mandate action cap cannot be below the daily trade cap." });
  }
  if (integerIn(plan.maxMandateOccurrences, 1, 100_000) && integerIn(plan.maxTotalTrades, 1, 10_000) && BigInt(plan.maxMandateOccurrences) > BigInt(plan.maxTotalTrades)) {
    diagnostics.push({ code: "mandate_occurrences_above_lifetime_trades", path: "limits.max_mandate_occurrences", message: "Immutable mandate action cap cannot exceed the owner, Testnet, exact-asset lifetime total-trades cap." });
  }
  if (!positiveDecimal(plan.maxCumulativeValue)) diagnostics.push({ code: "invalid_cumulative_value", path: "limits.max_cumulative_value", message: "Cumulative value must be a positive canonical decimal." });
  if (!integerIn(plan.maxDailyFeeDrops, 1, 9_000_000_000)) diagnostics.push({ code: "invalid_daily_fees", path: "limits.max_daily_fee_drops", message: "Daily fees must be positive whole drops." });
  if (!integerIn(plan.maxCumulativeFeeDrops, 1, 9_000_000_000)) diagnostics.push({ code: "invalid_cumulative_fees", path: "limits.max_cumulative_fee_drops", message: "Cumulative fees must be positive whole drops." });
  if (!Array.isArray(plan.rules)) return [...diagnostics, { code: "malformed_rules", path: "plan.rules", message: "Rules must be a finite array." }];
  if (plan.rules.length === 0) diagnostics.push({ code: "missing_rule", path: "plan.rules", message: "Add at least one supported rule." });
  if (plan.rules.length > MAX_DECLARATIVE_RULES) diagnostics.push({ code: "plan_too_large", path: "plan.rules", message: `A plan supports at most ${MAX_DECLARATIVE_RULES} ordered rules.` });
  const ids = new Set<string>();
  plan.rules.forEach((rule, index) => {
    const path = `plan.rules.${index}`;
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) { diagnostics.push({ code: "malformed_rule", path, message: "Each rule must be a structured object." }); return; }
    const allowedRuleKeys = new Set(["id", "kind", "price", "fixedValue", "lowerXrpBps", "targetXrpBps", "upperXrpBps"]);
    for (const key of Object.keys(rule)) if (!allowedRuleKeys.has(key)) diagnostics.push({ code: "unsupported_field", path: `${path}.${key}`, message: "This field is not part of a reviewed primitive." });
    if (!["scheduled_buy", "price_buy", "price_sell", "rebalance"].includes(rule.kind)) { diagnostics.push({ code: "unsupported_rule", path: `${path}.kind`, message: "Only scheduled buy, executable-price buy/sell, and allocation rebalance are supported." }); return; }
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(rule.id)) diagnostics.push({ code: "invalid_rule_id", path: `${path}.id`, message: "Rule ID must be lowercase letters, digits, or dashes." });
    if (ids.has(rule.id)) diagnostics.push({ code: "duplicate_rule_id", path: `${path}.id`, message: "Rule IDs must be unique." });
    ids.add(rule.id);
    if ((rule.kind === "scheduled_buy" || rule.kind === "price_buy" || rule.kind === "price_sell") && !positiveDecimal(rule.fixedValue)) diagnostics.push({ code: "invalid_fixed_value", path: `${path}.action.value`, message: "Fixed trade value must be a positive canonical decimal." });
    if ((rule.kind === "price_buy" || rule.kind === "price_sell") && !positiveDecimal(rule.price)) diagnostics.push({ code: "invalid_price", path: `${path}.conditions.0.value`, message: "Price threshold must be a positive canonical decimal." });
    if (rule.kind === "rebalance") {
      const values = [rule.lowerXrpBps, rule.targetXrpBps, rule.upperXrpBps];
      if (!values.every((value) => integerIn(value, 0, 10_000)) || !(BigInt(rule.lowerXrpBps || "0") < BigInt(rule.targetXrpBps || "0") && BigInt(rule.targetXrpBps || "0") < BigInt(rule.upperXrpBps || "0"))) {
        diagnostics.push({ code: "invalid_allocation_band", path: `${path}.action`, message: "Rebalance target must sit strictly inside a 0–10,000 bps band." });
      }
    }
  });
  return diagnostics;
}

/** UI-side shape only; Harbor recompiles and validates this untrusted proposal. */
export function compileDeclarativePlan(plan: DeclarativePlanDraft) {
  return {
    plan_version: "1" as const,
    trigger: { kind: "interval" as const, interval_seconds: Number(plan.intervalSeconds) },
    rules: plan.rules.map((rule) => ({
      rule_id: rule.id,
      all: rule.kind === "scheduled_buy"
        ? [{ kind: "always" as const }]
        : rule.kind === "price_buy"
          ? [{ kind: "price_threshold" as const, side: "ask" as const, comparator: "lte" as const, price: rule.price }]
          : rule.kind === "price_sell"
            ? [{ kind: "price_threshold" as const, side: "bid" as const, comparator: "gte" as const, price: rule.price }]
            : [{ kind: "xrp_allocation_outside" as const, lower_xrp_bps: Number(rule.lowerXrpBps), upper_xrp_bps: Number(rule.upperXrpBps) }],
      action: rule.kind === "rebalance"
        ? { kind: "target_allocation" as const, target_xrp_bps: Number(rule.targetXrpBps), lower_xrp_bps: Number(rule.lowerXrpBps), upper_xrp_bps: Number(rule.upperXrpBps) }
        : { kind: "fixed_swap" as const, direction: rule.kind === "price_sell" ? "sell_xrp" as const : "buy_xrp" as const, order_value: rule.fixedValue },
    })),
    fallback: { kind: "hold" as const },
  };
}

/** Deterministic paper-only evaluation of explicit user inputs. No live quote or fill is implied. */
export function previewDeclarativePlan(plan: DeclarativePlanDraft, inputs: PaperInputs): PaperPreview {
  if (validateDeclarativePlan(plan).length > 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(inputs.observedAt) || !positiveDecimal(inputs.executableBid) || !positiveDecimal(inputs.executableAsk) || compareDecimal(inputs.executableBid, inputs.executableAsk) > 0 || !integerIn(inputs.xrpAllocationBps, 0, 10_000)) {
    return { status: "not_ready", explanation: "Enter explicit paper inputs and resolve every validation error. No market data is inferred." };
  }
  const allocation = Number(inputs.xrpAllocationBps);
  for (const rule of plan.rules) {
    const matches = rule.kind === "scheduled_buy" ||
      (rule.kind === "price_buy" && compareDecimal(inputs.executableAsk, rule.price) <= 0) ||
      (rule.kind === "price_sell" && compareDecimal(inputs.executableBid, rule.price) >= 0) ||
      (rule.kind === "rebalance" && (allocation < Number(rule.lowerXrpBps) || allocation > Number(rule.upperXrpBps)));
    if (matches) return { status: "planned", matchedRuleId: rule.id, action: describeRule(rule), explanation: "The first matching rule plans one bounded action. Harbor would still re-read validated ledger data and enforce every mandate and policy limit." };
  }
  return { status: "hold", explanation: "No rule matches these explicit paper inputs. No action is planned." };
}
