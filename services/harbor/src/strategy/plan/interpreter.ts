import {
  DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
  DeclarativeStrategyMandateSchema,
  StrategyDecisionSchema,
  StrategyPlanObservationSchema,
  StrategyPlanPreviewSchema,
  type DeclarativeStrategyAction,
  type DeclarativeStrategyMandate,
  type DeclarativeStrategyProposal,
  type StrategyDecision,
  type StrategyHoldCode,
  type StrategyPlanObservation,
  type StrategyPlanPreview,
} from "../../contracts";
import { compileDeclarativeStrategyProposal } from "./compiler";

const SCALE = 1_000_000_000_000_000n;
const XRP_DROPS = 1_000_000n;

export type DeclarativeStrategyAuthority =
  | DeclarativeStrategyProposal
  | DeclarativeStrategyMandate;

export type EvaluateDeclarativeStrategyInput = {
  authority: DeclarativeStrategyAuthority;
  observation: StrategyPlanObservation;
  triggerId: string;
  decisionId: string;
  now: Date;
};

export type DeclarativeStrategyEvaluation = {
  preview: StrategyPlanPreview;
  decision: StrategyDecision;
};

function parseDecimal(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(15, "0"));
}

function formatDecimal(value: bigint): string {
  const whole = value / SCALE;
  const fraction = (value % SCALE)
    .toString()
    .padStart(15, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function min(...values: bigint[]): bigint {
  return values.reduce((result, value) => (value < result ? value : result));
}

function proposalFromAuthority(
  authority: DeclarativeStrategyAuthority,
): DeclarativeStrategyProposal {
  const {
    semantics_version,
    kind,
    network,
    account,
    issued_asset,
    plan,
    limits,
    execution_mode,
    not_before,
    expires_at,
  } = authority;
  return {
    semantics_version,
    kind,
    network,
    account,
    issued_asset,
    plan,
    limits,
    execution_mode,
    not_before,
    expires_at,
  };
}

function isMandate(
  authority: DeclarativeStrategyAuthority,
): authority is DeclarativeStrategyMandate {
  return "mandate_id" in authority;
}

function result(
  input: EvaluateDeclarativeStrategyInput,
  planDigest: string,
  action: "hold" | "buy_xrp" | "sell_xrp",
  explanation: string,
  holdCodes: StrategyHoldCode[],
  options: {
    matchedRuleId?: string;
    proposedValue?: string;
    priceBasis?: "bid" | "ask";
    priceValue?: string;
    allocationBps?: number;
    mandate?: DeclarativeStrategyMandate;
  } = {},
): DeclarativeStrategyEvaluation {
  const authority = input.authority;
  const mandateVersion = options.mandate?.version ?? 1;
  const mandateDigest = options.mandate?.digest ?? planDigest;
  const strategyId = options.mandate?.strategy_id ?? "strategy:paper-preview";
  const preview = StrategyPlanPreviewSchema.parse({
    boundary: "paper_only",
    ledger_acceptance: "not_tested",
    semantics_version: DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
    plan_digest: planDigest,
    outcome: action === "hold" ? "hold" : "order",
    action,
    ...(options.matchedRuleId
      ? { matched_rule_id: options.matchedRuleId }
      : {}),
    ...(options.proposedValue
      ? { proposed_value: options.proposedValue }
      : {}),
    ...(options.priceBasis ? { price_basis: options.priceBasis } : {}),
    ...(options.priceValue ? { price_value: options.priceValue } : {}),
    hold_codes: holdCodes,
    explanation,
    evaluated_at: input.now.toISOString(),
    observed_at: input.observation.observed_at,
    quote_ledger_index: input.observation.quote_ledger_index,
  });
  const decision = StrategyDecisionSchema.parse({
    decision_id: input.decisionId,
    trigger_id: input.triggerId,
    strategy_id: strategyId,
    mandate_digest: mandateDigest,
    mandate_version: mandateVersion,
    action,
    hold_codes: holdCodes,
    ...(options.allocationBps === undefined
      ? {}
      : { xrp_allocation_bps: options.allocationBps }),
    ...(options.proposedValue
      ? { proposed_value: options.proposedValue }
      : {}),
    semantics_version: DECLARATIVE_STRATEGY_SEMANTICS_VERSION,
    plan_digest: planDigest,
    ...(options.matchedRuleId
      ? { matched_rule_id: options.matchedRuleId }
      : {}),
    quote_ledger_index: input.observation.quote_ledger_index,
    quote_observed_at: input.observation.observed_at,
    explanation,
    created_at: input.now.toISOString(),
  });
  return { preview, decision };
}

function conditionMatches(
  condition: DeclarativeStrategyProposal["plan"]["rules"][number]["all"][number],
  observation: StrategyPlanObservation,
  allocationBps: number,
): boolean {
  if (condition.kind === "always") return true;
  if (condition.kind === "xrp_allocation_outside") {
    return (
      allocationBps < condition.lower_xrp_bps ||
      allocationBps > condition.upper_xrp_bps
    );
  }
  const price = parseDecimal(observation[condition.side]);
  const threshold = parseDecimal(condition.price);
  return condition.comparator === "lte"
    ? price <= threshold
    : price >= threshold;
}

function boundedActionValue(
  action: DeclarativeStrategyAction,
  observation: StrategyPlanObservation,
  proposal: DeclarativeStrategyProposal,
  allocationBps: number,
): { direction?: "buy_xrp" | "sell_xrp"; value?: bigint; hold?: StrategyHoldCode } {
  if (action.kind === "fixed_swap") {
    return {
      direction: action.direction,
      value: parseDecimal(action.order_value),
    };
  }
  if (
    allocationBps >= action.lower_xrp_bps &&
    allocationBps <= action.upper_xrp_bps
  ) {
    return { hold: "inside_band" };
  }
  const mid =
    (parseDecimal(observation.bid) + parseDecimal(observation.ask)) / 2n;
  const xrpValue =
    (BigInt(observation.xrp_balance_drops) * mid) / XRP_DROPS;
  const issued = parseDecimal(observation.issued_balance);
  const total = xrpValue + issued;
  const target = (total * BigInt(action.target_xrp_bps)) / 10_000n;
  const direction = xrpValue < target ? "buy_xrp" : "sell_xrp";
  const gap = xrpValue < target ? target - xrpValue : xrpValue - target;
  return {
    direction,
    value: min(gap, parseDecimal(proposal.limits.max_order_value)),
  };
}

/**
 * Pure except for deterministic SHA-256. It reads no clock, service, model,
 * wallet, database, or network and emits at most one proposed FOK order.
 */
export async function evaluateDeclarativeStrategy(
  rawInput: EvaluateDeclarativeStrategyInput,
): Promise<DeclarativeStrategyEvaluation> {
  if (!Number.isFinite(rawInput.now.getTime())) {
    throw new TypeError("evaluation time is invalid");
  }
  const observation = StrategyPlanObservationSchema.parse(rawInput.observation);
  const authority = isMandate(rawInput.authority)
    ? DeclarativeStrategyMandateSchema.parse(rawInput.authority)
    : rawInput.authority;
  const proposal = proposalFromAuthority(authority);
  const compiled = await compileDeclarativeStrategyProposal(proposal);
  const input = { ...rawInput, authority, observation };
  const mandate = isMandate(authority) ? authority : undefined;
  const hold = (
    code: StrategyHoldCode,
    explanation: string,
    allocationBps?: number,
  ) =>
    result(input, compiled.planDigest, "hold", explanation, [code], {
      allocationBps,
      mandate,
    });

  if (
    observation.account !== proposal.account ||
    observation.network !== proposal.network ||
    observation.issued_asset.currency !== proposal.issued_asset.currency ||
    observation.issued_asset.issuer !== proposal.issued_asset.issuer
  ) {
    return hold(
      "contradictory_price",
      "Observation scope does not match the immutable proposal.",
    );
  }
  if (mandate && mandate.digest !== compiled.planDigest) {
    return hold(
      "mandate_not_current",
      "Mandate digest does not bind the compiled declarative authority.",
    );
  }
  if (observation.global_kill) {
    return hold("global_kill", "The global kill switch blocks new submissions.");
  }
  if (observation.unresolved_execution) {
    return hold(
      "pending_reconciliation",
      "A prior submission remains unresolved.",
    );
  }
  if (mandate && (mandate.status !== "approved" || !mandate.authorization)) {
    return hold(
      "mandate_not_current",
      "The current mandate is not owner approved.",
    );
  }
  if (
    rawInput.now.getTime() < Date.parse(proposal.not_before) ||
    rawInput.now.getTime() >= Date.parse(proposal.expires_at) ||
    (mandate?.authorization &&
      rawInput.now.getTime() >= Date.parse(mandate.authorization.expires_at))
  ) {
    return hold(
      "mandate_expired",
      "The authority is outside its approved time window.",
    );
  }
  if (!observation.grant_active) {
    return hold("grant_not_active", "The delegated OfferCreate grant is not active.");
  }
  if (!observation.policy_active) {
    return hold(
      "policy_paused",
      "Current Harbor policy does not permit execution.",
    );
  }
  const quoteAgeMs =
    rawInput.now.getTime() - Date.parse(observation.observed_at);
  if (
    !Number.isFinite(quoteAgeMs) ||
    quoteAgeMs < 0 ||
    quoteAgeMs > proposal.limits.max_quote_age_seconds * 1_000
  ) {
    return hold("stale_price", "The executable quote is stale.");
  }
  if (
    observation.quote_ledger_index > observation.ledger_index ||
    observation.ledger_index - observation.quote_ledger_index >
      proposal.limits.max_ledger_gap ||
    parseDecimal(observation.ask) < parseDecimal(observation.bid)
  ) {
    return hold(
      "contradictory_price",
      "Quote sides or validated-ledger provenance are contradictory.",
    );
  }
  const bid = parseDecimal(observation.bid);
  const ask = parseDecimal(observation.ask);
  const quoteMid = (bid + ask) / 2n;
  const spreadBps =
    ((ask - bid) * 10_000n + quoteMid - 1n) / quoteMid;
  if (spreadBps > BigInt(proposal.limits.max_price_impact_bps)) {
    return hold(
      "insufficient_liquidity",
      "Executable spread exceeds the approved price-impact limit.",
    );
  }
  const fee = BigInt(observation.fee_drops);
  if (fee > BigInt(proposal.limits.max_fee_drops)) {
    return hold("fee_limit", "The estimated fee exceeds the per-order limit.");
  }
  if (
    BigInt(observation.daily_fee_drops_used) + fee >
      BigInt(proposal.limits.max_daily_fee_drops) ||
    BigInt(observation.cumulative_fee_drops_used) + fee >
      BigInt(proposal.limits.max_cumulative_fee_drops)
  ) {
    return hold(
      "fee_budget_limit",
      "Daily or owner/network/asset lifetime fee budget is exhausted.",
    );
  }
  if (
    observation.daily_trades_used + 1 > proposal.limits.max_daily_trades ||
    observation.total_trades_used + 1 > proposal.limits.max_total_trades
  ) {
    return hold(
      "trade_count_limit",
      "Daily or owner/network/asset lifetime trade-count budget is exhausted.",
    );
  }
  if (
    observation.last_trade_at &&
    rawInput.now.getTime() - Date.parse(observation.last_trade_at) <
      proposal.limits.cooldown_seconds * 1_000
  ) {
    return hold("cooldown", "The approved cooldown is still active.");
  }
  const mid = quoteMid;
  const xrpValue =
    (BigInt(observation.xrp_balance_drops) * mid) / XRP_DROPS;
  const issued = parseDecimal(observation.issued_balance);
  const total = xrpValue + issued;
  if (total <= 0n) return hold("missing_price", "Portfolio value is unavailable.");
  const allocationBps = Number((xrpValue * 10_000n) / total);
  const rule = proposal.plan.rules.find((candidate) =>
    candidate.all.every((condition) =>
      conditionMatches(condition, observation, allocationBps),
    ),
  );
  if (!rule) {
    return hold(
      "no_rule_matched",
      "No approved rule matched this explicit observation.",
      allocationBps,
    );
  }
  const planned = boundedActionValue(
    rule.action,
    observation,
    proposal,
    allocationBps,
  );
  if (planned.hold || !planned.direction || planned.value === undefined) {
    return hold(
      planned.hold ?? "condition_not_met",
      "The matched rule requires no order for the current allocation.",
      allocationBps,
    );
  }
  if (planned.value < parseDecimal(proposal.limits.min_order_value)) {
    return hold(
      "below_minimum_trade",
      "The bounded order is below the approved minimum.",
      allocationBps,
    );
  }
  if (planned.value > parseDecimal(proposal.limits.max_order_value)) {
    return hold("order_limit", "The order exceeds the per-order cap.", allocationBps);
  }
  if (
    parseDecimal(observation.daily_value_used) + planned.value >
    parseDecimal(proposal.limits.max_daily_value)
  ) {
    return hold("daily_limit", "The daily value budget is exhausted.", allocationBps);
  }
  if (
    parseDecimal(observation.cumulative_value_used) + planned.value >
    parseDecimal(proposal.limits.max_cumulative_value)
  ) {
    return hold(
      "cumulative_limit",
      "The owner/network/asset lifetime value budget is exhausted.",
      allocationBps,
    );
  }
  if (
    parseDecimal(observation.executable_liquidity_value) <
      parseDecimal(proposal.limits.min_liquidity_value) ||
    planned.value > parseDecimal(observation.executable_liquidity_value)
  ) {
    return hold(
      "insufficient_liquidity",
      "Executable liquidity cannot support the bounded order.",
      allocationBps,
    );
  }

  const priceBasis = planned.direction === "buy_xrp" ? "ask" : "bid";
  const price = parseDecimal(observation[priceBasis]);
  const orderDrops =
    (planned.value * XRP_DROPS + price - 1n) / price;
  const reserve =
    BigInt(observation.reserve_base_drops) +
    BigInt(observation.reserve_increment_drops) * BigInt(observation.owner_count);
  const reserveFloor =
    reserve > BigInt(proposal.limits.min_xrp_reserve_drops)
      ? reserve
      : BigInt(proposal.limits.min_xrp_reserve_drops);
  const currentDrops = BigInt(observation.xrp_balance_drops);
  if (planned.direction === "buy_xrp") {
    if (issued < planned.value) {
      return hold("exposure_limit", "Issued balance cannot fund the order.", allocationBps);
    }
    if (
      currentDrops + orderDrops >
      BigInt(proposal.limits.max_xrp_exposure_drops)
    ) {
      return hold("exposure_limit", "XRP exposure would exceed its cap.", allocationBps);
    }
  } else {
    if (
      currentDrops <
      orderDrops +
        reserveFloor +
        BigInt(proposal.limits.fee_buffer_drops) +
        fee
    ) {
      return hold(
        "reserve_limit",
        "XRP reserve and fee buffer leave insufficient sellable XRP.",
        allocationBps,
      );
    }
    if (
      issued + planned.value >
      parseDecimal(proposal.limits.max_issued_exposure)
    ) {
      return hold(
        "exposure_limit",
        "Issued-asset exposure would exceed its cap.",
        allocationBps,
      );
    }
  }
  const proposedValue = formatDecimal(planned.value);
  return result(
    input,
    compiled.planDigest,
    planned.direction,
    `${planned.direction === "buy_xrp" ? "Buy" : "Sell"} XRP under first matching rule ${rule.rule_id}; execution uses the executable ${priceBasis}.`,
    [],
    {
      matchedRuleId: rule.rule_id,
      proposedValue,
      priceBasis,
      priceValue: observation[priceBasis],
      allocationBps,
      mandate,
    },
  );
}
