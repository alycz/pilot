import {
  StrategyDecisionSchema,
  type StrategyDecision,
  type StrategyHoldCode,
  type StrategyMandate,
} from "../contracts";

const SCALE = 1_000_000_000_000_000n;
const XRP_DROPS = 1_000_000n;

export type StrategyObservation = {
  account: string;
  network: "testnet";
  issuedCurrency: string;
  issuedIssuer: string;
  xrpBalanceDrops: string;
  issuedBalance: string;
  /** Issued-asset units per XRP. */
  bid: string;
  ask: string;
  executableLiquidityValue: string;
  feeDrops: string;
  reserveBaseDrops: string;
  reserveIncrementDrops: string;
  ownerCount: number;
  pendingDailyValue: string;
  ledgerIndex: number;
  quoteLedgerIndex: number;
  observedAt: string;
  lastTradeAt?: string;
  globalKill?: boolean;
  unresolvedExecution?: boolean;
  grantActive?: boolean;
  policyActive?: boolean;
};

export type DecideInput = {
  mandate: StrategyMandate;
  observation: StrategyObservation;
  triggerId: string;
  decisionId: string;
  now: Date;
};

function parseDecimal(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,15})?$/.test(value)) {
    throw new TypeError("decimal is not canonical");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(15, "0"));
}

function parseDrops(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new TypeError("drops are not canonical");
  return BigInt(value);
}

function formatDecimal(value: bigint): string {
  if (value < 0n) throw new RangeError("decimal cannot be negative");
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(15, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function min(...values: bigint[]): bigint {
  return values.reduce((result, value) => (value < result ? value : result));
}

function hold(
  input: DecideInput,
  holdCodes: StrategyHoldCode[],
  explanation: string,
  allocation?: number,
): StrategyDecision {
  return StrategyDecisionSchema.parse({
    decision_id: input.decisionId,
    trigger_id: input.triggerId,
    strategy_id: input.mandate.strategy_id,
    mandate_digest: input.mandate.digest,
    mandate_version: input.mandate.version,
    action: "hold",
    hold_codes: holdCodes,
    ...(allocation === undefined ? {} : { xrp_allocation_bps: allocation }),
    explanation,
    created_at: input.now.toISOString(),
  });
}

/** Pure, deterministic and fixed-point. It never reads a clock or service. */
export function decideRebalance(input: DecideInput): StrategyDecision {
  const { mandate, observation: observation, now } = input;
  if (
    observation.network !== "testnet" ||
    observation.account !== mandate.account ||
    observation.issuedCurrency !== mandate.issued_asset.currency ||
    observation.issuedIssuer !== mandate.issued_asset.issuer
  ) {
    return hold(input, ["contradictory_price"], "Observation scope does not match the immutable mandate.");
  }
  if (observation.globalKill) return hold(input, ["global_kill"], "The global kill switch blocks new submissions.");
  if (observation.unresolvedExecution) return hold(input, ["pending_reconciliation"], "A prior submission remains unresolved.");
  if (mandate.status !== "approved" || !mandate.authorization) {
    return hold(input, ["mandate_not_current"], "The current mandate is not owner approved.");
  }
  if (now.getTime() < Date.parse(mandate.not_before) || now.getTime() >= Date.parse(mandate.expires_at)) {
    return hold(input, ["mandate_expired"], "The approved mandate is outside its authorization window.");
  }
  if (observation.grantActive !== true) return hold(input, ["grant_not_active"], "The delegated grant is not active.");
  if (observation.policyActive !== true) return hold(input, ["policy_paused"], "Current Harbor policy does not permit execution.");

  let xrpDrops: bigint;
  let issued: bigint;
  let bid: bigint;
  let ask: bigint;
  let liquidity: bigint;
  let fee: bigint;
  let reserve: bigint;
  let pendingDaily: bigint;
  try {
    xrpDrops = parseDrops(observation.xrpBalanceDrops);
    issued = parseDecimal(observation.issuedBalance);
    bid = parseDecimal(observation.bid);
    ask = parseDecimal(observation.ask);
    liquidity = parseDecimal(observation.executableLiquidityValue);
    fee = parseDrops(observation.feeDrops);
    const ledgerReserve = parseDrops(observation.reserveBaseDrops) +
      parseDrops(observation.reserveIncrementDrops) * BigInt(observation.ownerCount);
    const mandateReserve = parseDrops(mandate.limits.min_xrp_reserve_drops);
    reserve = (ledgerReserve > mandateReserve ? ledgerReserve : mandateReserve) +
      parseDrops(mandate.limits.fee_buffer_drops);
    pendingDaily = parseDecimal(observation.pendingDailyValue);
  } catch {
    return hold(input, ["missing_price"], "Balances or quote evidence are missing or malformed.");
  }
  if (bid <= 0n || ask <= 0n || ask < bid || observation.quoteLedgerIndex > observation.ledgerIndex ||
      observation.ledgerIndex - observation.quoteLedgerIndex > mandate.limits.max_ledger_gap) {
    return hold(input, ["contradictory_price"], "Quote sides or validated-ledger provenance are contradictory.");
  }
  const quoteAgeMs = now.getTime() - Date.parse(observation.observedAt);
  if (!Number.isFinite(quoteAgeMs) || quoteAgeMs < 0 || quoteAgeMs > mandate.limits.max_quote_age_seconds * 1_000) {
    return hold(input, ["stale_price"], "The executable quote is stale.");
  }
  if (fee > parseDrops(mandate.limits.max_fee_drops)) {
    return hold(input, ["fee_limit"], "The autofilled fee exceeds the mandate limit.");
  }
  const mid = (bid + ask) / 2n;
  const spreadBps = mid === 0n ? 10_001n : ((ask - bid) * 10_000n + mid - 1n) / mid;
  if (spreadBps > BigInt(mandate.limits.max_price_impact_bps)) {
    return hold(input, ["insufficient_liquidity"], "Executable spread exceeds the mandate limit.");
  }
  if (liquidity < parseDecimal(mandate.limits.min_liquidity_value)) {
    return hold(input, ["insufficient_liquidity"], "Executable liquidity is below the mandate minimum.");
  }
  if (observation.lastTradeAt && now.getTime() - Date.parse(observation.lastTradeAt) < mandate.limits.cooldown_seconds * 1_000) {
    return hold(input, ["cooldown"], "The strategy cooldown is still active.");
  }

  const xrpUnits = (xrpDrops * SCALE) / XRP_DROPS;
  const xrpValue = (xrpUnits * mid) / SCALE;
  const totalValue = xrpValue + issued;
  if (totalValue <= 0n) return hold(input, ["missing_price"], "Portfolio value is unavailable.");
  const allocationBps = Number((xrpValue * 10_000n) / totalValue);
  if (allocationBps >= mandate.allocation.lower_xrp_bps && allocationBps <= mandate.allocation.upper_xrp_bps) {
    return hold(input, ["inside_band"], "XRP allocation remains inside the approved band.", allocationBps);
  }

  const targetXrpValue = (totalValue * BigInt(mandate.allocation.target_xrp_bps)) / 10_000n;
  const direction = xrpValue < targetXrpValue ? "buy_xrp" : "sell_xrp";
  const gap = xrpValue < targetXrpValue ? targetXrpValue - xrpValue : xrpValue - targetXrpValue;
  const dailyRemaining = parseDecimal(mandate.limits.max_daily_value) - pendingDaily;
  if (dailyRemaining <= 0n) return hold(input, ["daily_limit"], "The mandate daily budget is fully reserved.", allocationBps);
  let proposed = min(gap, parseDecimal(mandate.limits.max_order_value), dailyRemaining, liquidity);
  if (direction === "buy_xrp") {
    proposed = min(proposed, issued, parseDrops(mandate.limits.max_xrp_exposure_drops) * mid / XRP_DROPS - xrpValue);
  } else {
    const availableDrops = xrpDrops - reserve - fee;
    if (availableDrops <= 0n) return hold(input, ["reserve_limit"], "XRP reserve and fee buffer leave no sellable XRP.", allocationBps);
    proposed = min(proposed, (availableDrops * mid) / XRP_DROPS, xrpValue);
    const issuedRoom = parseDecimal(mandate.limits.max_issued_exposure) - issued;
    if (issuedRoom <= 0n) return hold(input, ["exposure_limit"], "Issued-asset exposure is at its mandate limit.", allocationBps);
    proposed = min(proposed, issuedRoom);
  }
  if (proposed <= 0n) return hold(input, ["exposure_limit"], "Exposure or inventory limits prevent a trade.", allocationBps);
  if (proposed < parseDecimal(mandate.limits.min_order_value)) {
    return hold(input, ["below_minimum_trade"], "The bounded correction is below the mandate minimum trade.", allocationBps);
  }
  return StrategyDecisionSchema.parse({
    decision_id: input.decisionId,
    trigger_id: input.triggerId,
    strategy_id: mandate.strategy_id,
    mandate_digest: mandate.digest,
    mandate_version: mandate.version,
    action: direction,
    hold_codes: [],
    xrp_allocation_bps: allocationBps,
    proposed_value: formatDecimal(proposed),
    quote_ledger_index: observation.quoteLedgerIndex,
    quote_observed_at: observation.observedAt,
    explanation: `${direction === "buy_xrp" ? "Buy" : "Sell"} XRP toward the approved target within all current caps.`,
    created_at: now.toISOString(),
  });
}

/** Conservative integer micro-units used by the atomic D1 daily reservation. */
export function decimalToMicrounitsCeil(value: string): number {
  const scaled = parseDecimal(value);
  const divisor = SCALE / 1_000_000n;
  const result = (scaled + divisor - 1n) / divisor;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("value exceeds atomic budget range");
  return Number(result);
}
